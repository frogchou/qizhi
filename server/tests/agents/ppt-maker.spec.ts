import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, TaskEnvelope } from '../../packages/agent-protocol/src/index';
import type { CodexRunInput } from '../../packages/codex-runtime/src/index';
import { runTask } from '../../agents/ppt-maker/src/run-task';

describe('PPT maker agent', () => {
  it('requires a real pptx and QA report from the Codex runtime', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'ppt-maker-'));
    const reporter = { report: vi.fn(async (_event: AgentEvent) => undefined) };
    const codex = { run: vi.fn(async (input: CodexRunInput) => {
      await input.onStatus?.({ state: 'running', elapsedMs: 45_000, lastOutputAgeMs: 5_000, outputReceived: true });
      await writeFile(join(workspacePath, 'presentation.pptx'), 'pptx-bytes');
      await writeFile(join(workspacePath, 'ppt-qa.json'), JSON.stringify({ passed: true, rendered: true, checks: ['content', 'visual'], issues: [], slideCount: 3 }));
      return { lastMessage: 'created presentation' };
    }) };
    const result = await runTask(envelope(workspacePath), reporter, codex);
    expect(codex.run).toHaveBeenCalledOnce();
    expect(codex.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('input/evidence.md') }));
    expect(reporter.report.mock.calls.map(([event]) => event.type)).toEqual(['started', 'progress', 'heartbeat', 'checkpoint', 'completed']);
    expect(reporter.report.mock.calls.map(([event]) => event).find((event) => event.type === 'heartbeat')?.payload).toMatchObject({ runtime: 'codex', state: 'running', elapsedMs: 45_000, lastOutputAgeMs: 5_000 });
    expect(result).toMatchObject({ status: 'succeeded', risks: [], artifacts: [expect.objectContaining({ path: 'presentation.pptx' })] });
  });

  it('rejects a pre-existing PPT and QA report when Codex produces no fresh output', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'ppt-maker-'));
    await writeFile(join(workspacePath, 'presentation.pptx'), 'old-pptx-bytes');
    await writeFile(join(workspacePath, 'ppt-qa.json'), JSON.stringify({ passed: false, rendered: false, checks: [], issues: ['old output'], slideCount: 1 }));
    const reporter = { report: vi.fn(async (_event: AgentEvent) => undefined) };
    const codex = { run: vi.fn(async () => ({ lastMessage: 'did not write files' })) };

    await expect(runTask(envelope(workspacePath), reporter, codex)).rejects.toThrow('fresh presentation.pptx');
  });
});

function envelope(workspacePath: string): TaskEnvelope {
  return { protocolVersion: 'v1', taskId: 'task-ppt', taskNodeId: 'node-ppt', instanceId: 'instance-ppt', attemptNumber: 1, leaseToken: 'lease-token-with-at-least-24-characters', workspacePath, input: { brief: '制作季度经营汇报', title: '季度经营汇报', slideCount: 3, referenceMaterials: ['input/evidence.md'] }, callback: { url: 'http://127.0.0.1/events' } };
}
