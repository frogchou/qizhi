import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexCliRunner } from '../../packages/codex-runtime/src/index';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('CodexCliRunner', () => {
  it('delivers a large attachment prompt in full via stdin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mg-large-prompt-'));
    roots.push(root);
    const command = join(root, 'fake-codex');
    await writeFile(command, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.at(-1)!=='-')process.exit(7);
const prompt=fs.readFileSync(0,'utf8');
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],prompt);
`, {mode:0o700});
    const prompt = '附件资料'.repeat(18_000) + '\n原始记录结束';
    await expect(new CodexCliRunner({command}).run({workspacePath:root,prompt})).resolves.toEqual({lastMessage:prompt});
  });
  it('terminates a planning subprocess together with its wrapper on abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mg-cancel-planner-'));
    roots.push(root);
    const command = join(root, 'planner');
    await writeFile(command, '#!/bin/sh\nsleep 90 &\nworker=$!\ntrap "wait $worker; exit 0" TERM\necho "$worker"\nwait\n', { mode: 0o700 });
    const controller = new AbortController();
    let pid = 0;
    const run = new CodexCliRunner({ command }).run({
      workspacePath: root, prompt: 'test', signal: controller.signal,
      onOutput(entry) {
        if (entry.stream === 'stdout') { pid = Number(entry.chunk.trim()); controller.abort(); }
      },
    });
    await expect(run).rejects.toThrow(/cancelled/);
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('does not impose a hard timeout when the caller has not configured one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mg-codex-runner-'));
    roots.push(root);
    const fakeCodex = join(root, 'fake-codex');
    const finalMessage = '{"result":"long-running-content-job"}';
    await writeFile(fakeCodex, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst index = args.indexOf('--output-last-message');\nconst outputPath = args[index + 1];\nsetTimeout(() => { fs.writeFileSync(outputPath, ${JSON.stringify(finalMessage)}); process.exit(0); }, 80);\n`, 'utf8');
    await chmod(fakeCodex, 0o755);

    const realSetTimeout = global.setTimeout;
    const timers = vi.spyOn(global, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...arguments_: any[]) => {
      // The old implicit 180-second guard is shortened only in this parent
      // process, making the regression reproducible without a three-minute test.
      return realSetTimeout(handler, timeout === 180_000 ? 5 : timeout, ...arguments_);
    }) as typeof global.setTimeout);
    try {
      await expect(new CodexCliRunner({ command: fakeCodex }).run({ workspacePath: root, prompt: 'long job' }))
        .resolves.toEqual({ lastMessage: finalMessage });
    } finally {
      timers.mockRestore();
    }
  });

  it('reports that the Codex child remains active while a long content job runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mg-codex-runner-'));
    roots.push(root);
    const fakeCodex = join(root, 'fake-codex');
    const finalMessage = '{"result":"finished"}';
    await writeFile(fakeCodex, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst index = args.indexOf('--output-last-message');\nconst outputPath = args[index + 1];\nsetTimeout(() => { fs.writeFileSync(outputPath, ${JSON.stringify(finalMessage)}); process.exit(0); }, 80);\n`, 'utf8');
    await chmod(fakeCodex, 0o755);

    const states: string[] = [];
    const runner = new CodexCliRunner({ command: fakeCodex, statusIntervalMs: 10 } as never);
    await runner.run({
      workspacePath: root,
      prompt: 'report liveness',
      onStatus: (status: { state: string }) => { states.push(status.state); },
    } as never);

    expect(states).toContain('started');
    expect(states).toContain('running');
  });

  it('accepts a final output file when the CLI does not exit after writing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mg-codex-runner-'));
    roots.push(root);
    const fakeCodex = join(root, 'fake-codex');
    const finalMessage = '{"intent":"complete"}';
    await writeFile(fakeCodex, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nconst index = args.indexOf('--output-last-message');\nconst outputPath = args[index + 1];\nfs.writeFileSync(outputPath, ${JSON.stringify(finalMessage)});\nfs.writeFileSync(path.join(path.dirname(outputPath), 'child-env.txt'), process.env.MG_TEST_SECRET || '');\nsetInterval(() => {}, 1000);\n`, 'utf8');
    await chmod(fakeCodex, 0o755);

    const runner = new CodexCliRunner({ command: fakeCodex, defaultTimeoutMs: 2_000 });
    const priorSecret = process.env.MG_TEST_SECRET;
    process.env.MG_TEST_SECRET = 'must-not-reach-codex';
    try {
      await expect(runner.run({ workspacePath: root, prompt: 'no-op', timeoutMs: 2_000 }))
        .resolves.toEqual({ lastMessage: finalMessage });
      await expect(readFile(join(root, 'child-env.txt'), 'utf8')).resolves.toBe('');
    } finally {
      if (priorSecret === undefined) delete process.env.MG_TEST_SECRET;
      else process.env.MG_TEST_SECRET = priorSecret;
    }
  });

  it('does not complete a new invocation from a stale final-message file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mg-codex-runner-'));
    roots.push(root);
    const fakeCodex = join(root, 'fake-codex');
    const staleMessage = '{"result":"previous invocation"}';
    const freshMessage = '{"result":"fresh invocation"}';
    await writeFile(join(root, '.mg-codex-last-message.txt'), staleMessage, 'utf8');
    await writeFile(fakeCodex, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst index = args.indexOf('--output-last-message');\nconst outputPath = args[index + 1];\nsetTimeout(() => { fs.writeFileSync(outputPath, ${JSON.stringify(freshMessage)}); process.exit(0); }, 800);\n`, 'utf8');
    await chmod(fakeCodex, 0o755);

    await expect(new CodexCliRunner({ command: fakeCodex }).run({ workspacePath: root, prompt: 'fresh work' }))
      .resolves.toEqual({ lastMessage: freshMessage });
  });
});
