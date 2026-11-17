import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** Narrow, injectable boundary around the locally authenticated Codex CLI. */
export type CodexRuntimeStatus = {
  state: 'started' | 'running';
  elapsedMs: number;
  lastOutputAgeMs?: number;
  outputReceived: boolean;
};

export type CodexRunInput = {
  workspacePath: string;
  prompt: string;
  outputSchemaPath?: string;
  researchMode?: 'discovery' | 'synthesis';
  onSearch?: (query: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (entry: { stream: 'stdout' | 'stderr'; chunk: string }) => void | Promise<void>;
  onStatus?: (status: CodexRuntimeStatus) => void | Promise<void>;
};

export interface CodexRunner {
  run(input: CodexRunInput): Promise<{ lastMessage: string }>;
}

/**
 * Runs one Codex job in the task workspace. A time limit exists only when the
 * caller deliberately configures one; content-generating agents are observed
 * by liveness reports rather than cut off by an arbitrary global deadline.
 * The caller owns prompt construction; this class deliberately does not
 * expose the host filesystem as an additional writable directory.
 */
export class CodexCliRunner implements CodexRunner {
  public constructor(private readonly options: { command?: string; defaultTimeoutMs?: number; statusIntervalMs?: number } = {}) {}

  public async run(input: CodexRunInput): Promise<{ lastMessage: string }> {
    await mkdir(input.workspacePath, { recursive: true });
    const lastMessagePath = join(input.workspacePath, '.mg-codex-last-message.txt');
    // The sentinel belongs to one Codex invocation only. Keeping a previous
    // final message here would make the completion poll terminate new work.
    await rm(lastMessagePath, { force: true });
    const args = [
      ...(input.researchMode === 'discovery' ? ['--search'] : []),
      ...(input.researchMode ? ['--disable', 'shell_tool', '--disable', 'unified_exec'] : []),
      'exec',
      ...(input.researchMode ? ['--json'] : []),
      ...(input.researchMode === 'synthesis' ? ['-c', 'web_search="disabled"'] : []),
      '--cd', input.workspacePath,
      '--skip-git-repo-check',
      '--sandbox', input.researchMode ? 'read-only' : 'danger-full-access',
      '--output-last-message', lastMessagePath,
    ];
    if (input.outputSchemaPath) args.push('--output-schema', input.outputSchemaPath);
    // File contents and multi-round context may exceed the OS limit of one argument.
    args.push('-');
    let output: ProcessOutput;
    try {
      output = await runProcess(
        this.options.command ?? 'codex',
        args,
        input.prompt,
        input.workspacePath,
        input.timeoutMs ?? this.options.defaultTimeoutMs,
        lastMessagePath,
        input.signal,
        input.onOutput,
        input.onStatus,
        this.options.statusIntervalMs ?? 10_000,
        input.onSearch,
      );
    } catch (error) {
      const processError = error instanceof CodexProcessError ? error : new CodexProcessError(asMessage(error), { stdout: '', stderr: '' });
      await writeLogs(input.workspacePath, processError.output);
      throw processError;
    }
    await writeLogs(input.workspacePath, output);
    return { lastMessage: await readFile(lastMessagePath, 'utf8') };
  }
}

type ProcessOutput = { stdout: string; stderr: string };

class CodexProcessError extends Error {
  public constructor(message: string, public readonly output: ProcessOutput) { super(message); }
}

async function writeLogs(workspacePath: string, output: ProcessOutput): Promise<void> {
  await Promise.all([
    writeFile(join(workspacePath, '.mg-codex-stdout.log'), output.stdout, 'utf8'),
    writeFile(join(workspacePath, '.mg-codex-stderr.log'), output.stderr, 'utf8'),
  ]);
}

/**
 * Codex writes --output-last-message only after a completed final turn. Some
 * CLI releases occasionally leave their process alive after that write (for
 * example while a background model refresh is winding down).  Treat the
 * durable final-message file as completion after a short grace period. A
 * caller may still supply an explicit timeout for bounded work such as
 * planning, but content work has no implicit total-duration limit.
 */
function runProcess(command: string, args: string[], prompt: string, cwd: string, timeoutMs: number | undefined, lastMessagePath: string, signal?: AbortSignal, onOutput?: (entry: { stream: 'stdout' | 'stderr'; chunk: string }) => void | Promise<void>, onStatus?: (status: CodexRuntimeStatus) => void | Promise<void>, statusIntervalMs = 10_000, onSearch?: (query: string) => void): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const grouped = process.platform !== 'win32' && Boolean(signal);
    const child = spawn(command, args, { cwd, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'], env: codexEnvironment() });
    let inputError: Error | undefined;
    child.stdin.on('error', (error: Error) => { inputError = error; });
    child.stdin.end(prompt, 'utf8');
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let lastOutputAt: number | undefined;
    const appendBounded = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-128_000);
    const publishStatus = (state: CodexRuntimeStatus['state']) => {
      const now = Date.now();
      void Promise.resolve(onStatus?.({
        state,
        elapsedMs: now - startedAt,
        ...(lastOutputAt === undefined ? {} : { lastOutputAgeMs: now - lastOutputAt }),
        outputReceived: lastOutputAt !== undefined,
      })).catch(() => undefined);
    };
    const publish = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        lastOutputAt = Date.now();
        void Promise.resolve(onOutput?.({ stream, chunk: text.slice(-4_000) })).catch(() => undefined);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); publish('stdout', chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); publish('stderr', chunk); });
    if (onSearch) {
      // JSONL records can span pipe chunks. Only expose actual search tool events.
      let pending = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = (lines.pop() ?? '').slice(-64_000);
        for (const line of lines) {
          try {
            const { type, item } = JSON.parse(line);
            if (type === 'item.completed' && item?.type === 'web_search') {
              onSearch(String(item.query || item.action?.query || '公开资料').slice(0, 200));
            }
          } catch { /* Other CLI records are not research events. */ }
        }
      });
    }
    let timedOut = false;
    let exited = false;
    let finalOutputReady = false;
    let checkingFinalOutput = false;
    let forceKill: NodeJS.Timeout | undefined;
    let finishAfterOutput: NodeJS.Timeout | undefined;
    const statusTicker = setInterval(() => {
      if (!exited) publishStatus('running');
    }, Math.max(1, statusIntervalMs));
    const stopChild = () => {
      if (forceKill) return;
      const send = (name: NodeJS.Signals) => {
        if (!grouped || !child.pid) { child.kill(name); return; }
        try { process.kill(-child.pid, name); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      send('SIGTERM');
      forceKill = setTimeout(() => {
        if (grouped || !exited) send('SIGKILL');
      }, 5_000);
    };
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
    const cancel = () => stopChild();
    const finalOutputPoll = setInterval(() => {
      if (checkingFinalOutput || finalOutputReady || exited) return;
      checkingFinalOutput = true;
      void readFile(lastMessagePath, 'utf8')
        .then((message) => {
          if (message.trim().length === 0 || exited) return;
          finalOutputReady = true;
          clearInterval(finalOutputPoll);
          // Prefer a normal CLI exit. If it remains alive, close this completed
          // invocation rather than incorrectly consuming the task timeout.
          finishAfterOutput = setTimeout(() => {
            if (!exited) stopChild();
          }, 500);
        })
        .catch(() => undefined)
        .finally(() => { checkingFinalOutput = false; });
    }, 100);
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(finishAfterOutput);
      clearInterval(finalOutputPoll);
      clearInterval(statusTicker);
      signal?.removeEventListener('abort', cancel);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    publishStatus('started');
    child.once('error', (error) => { cleanup(); reject(new CodexProcessError(asMessage(error), { stdout, stderr })); });
    child.once('close', (code) => {
      // The CLI wrapper may exit before subprocesses that closed their pipes.
      if (grouped && child.pid && signal?.aborted) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { cleanup(); reject(error); return; }
        }
      }
      exited = true;
      cleanup();
      if (signal?.aborted) reject(new CodexProcessError('Codex runtime was cancelled.', { stdout, stderr }));
      else if (inputError && code === 0 && !finalOutputReady) reject(new CodexProcessError('Codex runtime did not receive the complete prompt.', { stdout, stderr }));
      else if (finalOutputReady) resolve({ stdout, stderr });
      else if (timedOut) reject(new CodexProcessError(`Codex runtime timed out after ${timeoutMs ?? 'the configured limit'}ms.`, { stdout, stderr }));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new CodexProcessError(`Codex runtime exited with code ${code ?? 'unknown'}: ${stderr.slice(-2_000)}`, { stdout, stderr }));
    });
  });
}

/**
 * Planning and content runtimes only need their local Codex login plus basic
 * process/locale paths. Never inherit the control-plane environment wholesale:
 * it contains database, registry and knowledge-base credentials that Codex
 * should neither read nor be able to forward through a shell command.
 */
function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  return Object.fromEntries(allowed.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]]));
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Codex runtime could not start.';
}
