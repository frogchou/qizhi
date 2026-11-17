import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, TaskEnvelope } from '../../packages/agent-protocol/src/index';
import type { CodexRunInput } from '../../packages/codex-runtime/src/index';
import { runTask } from '../../agents/quality-management/src/run-task';

describe('quality management agent', () => {
  it('creates criteria and returns a failed acceptance without modifying targets', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'quality-management-'));
    const target = join(workspacePath, 'draft.md');
    await writeFile(target, 'draft');
    const reporter = { report: vi.fn(async (_event: AgentEvent) => undefined) };
    const codex = { run: vi.fn(async (input: CodexRunInput) => {
      await input.onStatus?.({ state: 'running', elapsedMs: 30_000, outputReceived: false });
      await writeFile(join(workspacePath, 'quality-assessment.json'), JSON.stringify({ passed: false, criteria: [{ id: 'C1', criterion: 'contains conclusion', method: 'read document', required: true }], findings: [{ severity: 'major', message: 'missing conclusion', path: 'draft.md' }], summary: 'not accepted' }));
      return { lastMessage: 'assessment created' };
    }) };
    const result = await runTask(envelope(workspacePath), reporter, codex);
    expect(result).toMatchObject({ output: { passed: false }, risks: ['quality_acceptance_failed'] });
    expect(reporter.report.mock.calls.map(([event]) => event.type)).toContain('heartbeat');
    expect(reporter.report.mock.calls.map(([event]) => event).find((event) => event.type === 'heartbeat')?.payload).toMatchObject({ runtime: 'codex', state: 'running', elapsedMs: 30_000, outputReceived: false });
    await expect(readFile(target, 'utf8')).resolves.toBe('draft');
    await expect(readFile(join(workspacePath, 'acceptance-criteria.json'), 'utf8')).resolves.toContain('C1');
  });

  it('rejects a target path that escapes the workspace', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'quality-management-'));
    await expect(runTask({ ...envelope(workspacePath), input: { requirements: 'test', targets: ['../secret.txt'] } }, { report: vi.fn() }, { run: vi.fn() })).rejects.toThrow('stay inside');
  });
});

function envelope(workspacePath: string): TaskEnvelope {
  return { protocolVersion: 'v1', taskId: 'task-quality', taskNodeId: 'node-quality', instanceId: 'instance-quality', attemptNumber: 1, leaseToken: 'lease-token-with-at-least-24-characters', workspacePath, input: { requirements: '文档必须包含结论', targets: ['draft.md'], targetType: 'document' }, callback: { url: 'http://127.0.0.1/events' } };
}
