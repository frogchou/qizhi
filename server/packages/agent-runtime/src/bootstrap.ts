import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { Value } from '@sinclair/typebox/value';

import { AgentResultSchema, TaskEnvelopeSchema, type AgentResult, type TaskEnvelope } from '../../agent-protocol/src/index.js';
import { createEvent, HttpAgentReporter, HttpResultReporter, type AgentReporter } from './result-reporter.js';

export type AgentExecution = {
  envelope: TaskEnvelope;
  reporter: AgentReporter;
  complete(result: AgentResult): Promise<void>;
  fail(error: unknown): Promise<void>;
};

/**
 * Standard independent-instance bootstrap. It reads only systemd-provided
 * environment, validates task containment, and never loads secrets from task files.
 */
export async function loadAgentExecution(input: { environment?: NodeJS.ProcessEnv; fetchImpl?: typeof globalThis.fetch } = {}): Promise<AgentExecution> {
  const environment = input.environment ?? process.env;
  const envelopePath = environment.MG_TASK_ENVELOPE_PATH;
  if (!envelopePath) throw new Error('MG_TASK_ENVELOPE_PATH is required.');
  let envelope: unknown;
  try { envelope = JSON.parse(await readFile(envelopePath, 'utf8')); } catch { throw new Error('Task envelope cannot be read as JSON.'); }
  if (!Value.Check(TaskEnvelopeSchema, envelope)) {
    const first = Value.Errors(TaskEnvelopeSchema, envelope).First();
    throw new Error(`Task envelope does not match Agent Protocol v1 at ${first?.path || '/'}.`);
  }
  const validated = envelope as TaskEnvelope;
  if (validated.deadlineAt && !Number.isFinite(Date.parse(validated.deadlineAt))) throw new Error('Task envelope deadlineAt is not a valid ISO timestamp.');
  const taskRoot = validated.taskRoot;
  const nodeWorkspace = validated.nodeWorkspacePath;
  if (!taskRoot || !nodeWorkspace || !validated.resultCallback) throw new Error('Independent agent execution requires taskRoot, nodeWorkspacePath and resultCallback.');
  assertContained(resolve(taskRoot), resolve(nodeWorkspace), 'Node workspace');
  assertContained(resolve(taskRoot), resolve(envelopePath), 'Envelope');
  if (resolve(validated.workspacePath) !== resolve(nodeWorkspace)) throw new Error('Envelope workspacePath must equal nodeWorkspacePath.');
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const reporter = new HttpAgentReporter(validated.callback.url, fetchImpl);
  const results = new HttpResultReporter(validated.resultCallback.url, fetchImpl);
  let heartbeatSequence = 900_000;
  const startedAt = Date.now();
  const sendHeartbeat = () => void reporter.report(createEvent(validated, heartbeatSequence++, 'heartbeat', {
    status: 'alive', uptimeMs: Date.now() - startedAt,
  })).catch(() => undefined);
  // An immediate heartbeat distinguishes a genuinely booted process from a
  // launch request that merely obtained a systemd unit name.  It is followed
  // by a low-frequency liveness signal while long-running runtimes work.
  sendHeartbeat();
  const heartbeatTimer = setInterval(sendHeartbeat, 10_000);
  heartbeatTimer.unref();
  const stopHeartbeat = () => clearInterval(heartbeatTimer);

  const complete = async (result: AgentResult): Promise<void> => {
    validateResult(validated, result);
    const resultPath = join(nodeWorkspace, 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    const temporary = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await rename(temporary, resultPath);
    await results.report(validated.leaseToken, result);
    stopHeartbeat();
  };
  return {
    envelope: validated,
    reporter,
    complete,
    fail: async (error) => {
      const message = publicError(error);
      try { await reporter.report(createEvent(validated, 1_000_000, 'failed', { message })); } catch { /* Result callback remains the decisive terminal report. */ }
      await complete(failedResult(validated, message));
    },
  };
}

export function failedResult(envelope: TaskEnvelope, message: string): AgentResult {
  return {
    protocolVersion: 'v1', taskId: envelope.taskId, taskNodeId: envelope.taskNodeId, instanceId: envelope.instanceId,
    status: 'failed', output: { message }, evidence: [], risks: ['agent_execution_failed'], artifacts: [],
  };
}

function validateResult(envelope: TaskEnvelope, result: AgentResult): void {
  if (!Value.Check(AgentResultSchema, result)) throw new Error('Agent result does not match Agent Protocol v1.');
  if (result.taskId !== envelope.taskId || result.taskNodeId !== envelope.taskNodeId || result.instanceId !== envelope.instanceId) {
    throw new Error('Agent result identity does not match the leased envelope.');
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`${label} must remain contained in taskRoot.`);
}

function publicError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown agent execution error.').replace(/\s+/g, ' ').slice(0, 1_000);
}
