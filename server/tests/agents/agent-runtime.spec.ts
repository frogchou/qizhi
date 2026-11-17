import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAgentExecution } from '../../packages/agent-runtime/src/bootstrap';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (path) => (await import('node:fs/promises')).rm(path, { recursive: true, force: true }))); });

describe('independent agent runtime', () => {
  it('loads a contained envelope, stores result.json locally and posts the leased result callback', async () => {
    const { root, envelopePath } = await taskEnvelope();
    const fetchImpl = vi.fn(async () => new Response('', { status: 201 }));
    const execution = await loadAgentExecution({ environment: { MG_TASK_ENVELOPE_PATH: envelopePath }, fetchImpl });

    await execution.complete({
      protocolVersion: 'v1', taskId: 'task-runtime', taskNodeId: 'node-runtime', instanceId: 'instance-runtime', status: 'succeeded',
      output: { answer: 'done' }, evidence: [], risks: [], artifacts: [],
    });

    await expect(readFile(join(root, 'nodes', 'node-runtime', 'result.json'), 'utf8')).resolves.toContain('answer');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3010/internal/v1/instances/instance-runtime/result', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('lease-token-with-at-least'),
    }));
  });

  it('rejects an envelope whose node workspace escapes the declared task root', async () => {
    const { envelopePath } = await taskEnvelope({ nodeWorkspacePath: '/tmp/other-task' });
    await expect(loadAgentExecution({ environment: { MG_TASK_ENVELOPE_PATH: envelopePath } })).rejects.toThrow(/contain|workspace/i);
  });

  it('accepts the scheduler ISO deadline including milliseconds', async () => {
    const { envelopePath } = await taskEnvelope({ deadlineAt: '2026-11-11T08:40:30.032Z' });

    await expect(loadAgentExecution({ environment: { MG_TASK_ENVELOPE_PATH: envelopePath }, fetchImpl: async () => new Response('', { status: 201 }) })).resolves.toBeDefined();
  });
});

async function taskEnvelope(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mg-agent-runtime-'));
  roots.push(root);
  const node = join(root, 'nodes', 'node-runtime');
  await (await import('node:fs/promises')).mkdir(node, { recursive: true });
  const envelopePath = join(node, 'envelope.json');
  await writeFile(envelopePath, JSON.stringify({
    protocolVersion: 'v1', taskId: 'task-runtime', taskNodeId: 'node-runtime', instanceId: 'instance-runtime', attemptNumber: 1,
    leaseToken: 'lease-token-with-at-least-24-characters', workspacePath: node, taskRoot: root, nodeWorkspacePath: node,
    input: { query: 'test' }, callback: { url: 'http://127.0.0.1:3010/internal/v1/instances/instance-runtime/events' },
    resultCallback: { url: 'http://127.0.0.1:3010/internal/v1/instances/instance-runtime/result' },
    ...overrides,
  }), 'utf8');
  return { root, envelopePath };
}
