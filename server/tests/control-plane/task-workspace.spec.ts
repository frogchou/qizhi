import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function workspace(): Promise<{ service: TaskWorkspaceService; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mg-task-workspace-'));
  roots.push(root);
  return { root, service: new TaskWorkspaceService({ root }) };
}

describe('TaskWorkspaceService', () => {
  it('creates the complete task directory with safe task metadata and initial state', async () => {
    const { service } = await workspace();
    const task = await service.create({ id: 'task-438c', goal: '制作438c项目介绍PPT', acceptanceMode: 'platform_auto' });

    await expect(readFile(join(task.root, 'task.json'), 'utf8')).resolves.toContain('制作438c项目介绍PPT');
    await expect(readFile(join(task.root, 'state.json'), 'utf8')).resolves.toContain('received');
    expect(await readdir(task.root)).toEqual(expect.arrayContaining(['plans', 'session', 'nodes', 'artifacts', 'quality']));
    expect(task.root).toContain('task-438c');
  });

  it('creates node envelopes only below the selected task directory', async () => {
    const { service } = await workspace();
    await service.create({ id: 'task-438c', goal: '制作438c项目介绍PPT', acceptanceMode: 'platform_auto' });

    const node = await service.createNodeWorkspace('task-438c', 'retrieve-milestones');
    const envelopePath = await service.writeNodeEnvelope('task-438c', 'retrieve-milestones', { taskId: 'task-438c', node: 'retrieve-milestones' });

    expect(node).toContain(join('task-438c', 'nodes', 'retrieve-milestones'));
    await expect(readFile(envelopePath, 'utf8')).resolves.toContain('retrieve-milestones');
  });

  it('rejects task and artifact paths that escape the task root', async () => {
    const { service } = await workspace();
    await service.create({ id: 'task-438c', goal: '制作438c项目介绍PPT', acceptanceMode: 'platform_auto' });

    await expect(service.createNodeWorkspace('task-438c', '../outside')).rejects.toThrow(/segment|contain/i);
    await expect(service.resolveTaskPath('task-438c', '../another-task/result.json')).rejects.toThrow(/contain/i);
    await expect(service.resolveTaskPath('task-438c', '/etc/passwd')).rejects.toThrow(/relative|contain/i);
  });
});
