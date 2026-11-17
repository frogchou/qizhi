import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup(): Promise<{ workspace: TaskWorkspaceService; session: TaskSessionService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mg-task-session-'));
  roots.push(root);
  const workspace = new TaskWorkspaceService({ root });
  await workspace.create({ id: 'task-438c', goal: '制作438c项目介绍PPT', acceptanceMode: 'platform_auto' });
  return { root, workspace, session: new TaskSessionService(workspace) };
}

describe('TaskSessionService', () => {
  it('appends independent session entries and atomically replaces the current state snapshot', async () => {
    const { workspace, session } = await setup();
    await session.append('task-438c', { kind: 'planner', message: '开始分析任务', detail: { capabilityCount: 4 } });
    await session.append('task-438c', { kind: 'scheduler', message: '等待资料节点', detail: { readyNodes: 3 } });
    await session.writeStateSnapshot('task-438c', { state: 'running', currentNode: 'retrieve-overview' });
    await session.writeStateSnapshot('task-438c', { state: 'quality_review', currentNode: 'quality-check' });

    const root = workspace.taskRoot('task-438c');
    const lines = (await readFile(join(root, 'session', 'conversation.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    await expect(readFile(join(root, 'state.json'), 'utf8')).resolves.toContain('quality_review');
    expect((await readdir(root)).filter((name) => name.includes('state.') && name !== 'state.json')).toEqual([]);
  });

  it('refuses secrets in session or state files', async () => {
    const { session } = await setup();

    await expect(session.append('task-438c', { kind: 'planner', message: 'unsafe', detail: { apiKey: 'do-not-write' } })).rejects.toThrow(/secret/i);
    await expect(session.writeStateSnapshot('task-438c', { state: 'running', token: 'do-not-write' })).rejects.toThrow(/secret/i);
  });
});
