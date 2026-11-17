import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, TaskEnvelope } from '../../packages/agent-protocol/src/index';
import { runTask } from '../../agents/web-research/src/run-task';

describe('web research agent', () => {
  it('returns cited public sources and writes a traceable report', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'web-research-'));
    const reporter = { report: vi.fn(async (_event: AgentEvent) => undefined) };
    const search = { search: vi.fn().mockResolvedValue([{ title: 'OpenAI', url: 'https://openai.com/research', excerpt: 'Research publication' }]) };
    const result = await runTask(envelope(workspacePath), reporter, search);
    expect(search.search).toHaveBeenCalledWith('agent architecture', 3);
    expect(result.evidence[0]).toMatchObject({ source: 'https://openai.com/research' });
    expect(result.risks).toContain('public_web_sources_require_fact_check');
    await expect(readFile(join(workspacePath, 'web-research.md'), 'utf8')).resolves.toContain('https://openai.com/research');
  });
});

function envelope(workspacePath: string): TaskEnvelope {
  return { protocolVersion: 'v1', taskId: 'task-web', taskNodeId: 'node-web', instanceId: 'instance-web', attemptNumber: 1, leaseToken: 'lease-token-with-at-least-24-characters', workspacePath, input: { query: 'agent architecture', maxResults: 3 }, callback: { url: 'http://127.0.0.1/events' } };
}
