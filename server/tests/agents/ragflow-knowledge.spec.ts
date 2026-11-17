import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, TaskEnvelope } from '../../packages/agent-protocol/src/index';
import { performPackageSelfCheck, performSelfCheck, readRagflowAgentConfig } from '../../agents/ragflow-knowledge-v1.0.1/src/self-check';
import { runTask } from '../../agents/ragflow-knowledge/src/run-task';

const envelope: TaskEnvelope = {
  protocolVersion: 'v1',
  taskId: 'task-1',
  taskNodeId: 'node-1',
  instanceId: 'instance-1',
  attemptNumber: 1,
  leaseToken: 'lease-token-with-at-least-24-characters',
  workspacePath: '/home/middleground/data/workspaces/task-1',
  input: { query: '味道府客户资料' },
  callback: { url: 'http://127.0.0.1/internal/v1/instances/instance-1/events' },
};

describe('RAGFlow knowledge agent', () => {
  it('allows the post-approval package self-check to run without an enterprise credential', async () => {
    await expect(performPackageSelfCheck()).resolves.toEqual({ ok: true });
  });

  it('requires enterprise credentials only when a leased runtime configuration is read', () => {
    expect(() => readRagflowAgentConfig({ RAGFLOW_BASE_URL: 'http://ragflow.internal' })).toThrow('RAGFLOW_API_KEY');
  });

  it('performs a configuration-only self-check without querying enterprise knowledge', async () => {
    const retrieve = vi.fn();

    await expect(performSelfCheck({ baseUrl: 'http://ragflow.internal', apiKey: 'test-key', datasetIds: ['dataset-1'] })).resolves.toEqual({ ok: true });

    expect(retrieve).not.toHaveBeenCalled();
  });

  it('emits ordered lifecycle events and returns cited evidence', async () => {
    const eventTypes: string[] = [];
    const reporter = { report: vi.fn(async (event: AgentEvent) => { eventTypes.push(event.type); }) };
    const client = { retrieve: vi.fn().mockResolvedValue([{ id: 'chunk-1', datasetId: 'dataset-1', documentId: 'doc-1', content: '客户介绍', similarity: 0.9 }]) };

    const result = await runTask(envelope, reporter, client, ['dataset-1']);

    expect(eventTypes).toEqual(['started', 'progress', 'checkpoint', 'completed']);
    expect(result).toMatchObject({ status: 'succeeded', evidence: [expect.objectContaining({ source: 'ragflow:doc-1:chunk-1' })], risks: [] });
  });

  it('returns a successful empty-evidence result with a risk note', async () => {
    const reporter = { report: vi.fn() };
    const client = { retrieve: vi.fn().mockResolvedValue([]) };

    const result = await runTask(envelope, reporter, client, ['dataset-1']);

    expect(result).toMatchObject({ status: 'succeeded', evidence: [], risks: ['no_evidence'] });
  });
});
