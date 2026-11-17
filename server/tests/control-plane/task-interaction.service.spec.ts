import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskInteractionService } from '../../apps/control-plane/src/tasks/task-interaction.service';
import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const roots: string[] = [];

beforeAll(async () => { await dataSource.initialize(); });
afterAll(async () => { await dataSource.destroy(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function environment() {
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  const root = await mkdtemp(join(tmpdir(), 'mg-interaction-'));
  roots.push(root);
  const workspaces = new TaskWorkspaceService({ root });
  const task = await workspaces.create({ id: 'task-interaction', goal: '确认智能体需要的资料', acceptanceMode: 'platform_auto' });
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-interaction','确认智能体需要的资料','platform_auto','running',$1)`, [task.root]);
  const activities = { append: async () => undefined };
  const interactions = new TaskInteractionService(dataSource, workspaces, new TaskSessionService(workspaces), activities as any);
  return { workspaces, interactions };
}

const request = {
  kind: 'confirmation' as const,
  title: '确认网络访问范围',
  prompt: '新智能体是否需要访问公网？',
  responseTarget: 'task.session.network',
  responseSchema: {
    type: 'object' as const,
    required: ['internetAccess'],
    additionalProperties: false as const,
    properties: {
      internetAccess: { type: 'boolean' as const },
      allowedDomains: { type: 'array' as const, minItems: 0, maxItems: 5, items: { type: 'string' as const } },
    },
  },
};

describe('TaskInteractionService', () => {
  it('persists one pending request, validates its answer, and claims exactly one resume', async () => {
    const { workspaces, interactions } = await environment();
    const created = await interactions.requestPlanInteraction({ taskId: 'task-interaction', planNodeKey: 'confirm-network', request });

    expect(created).toMatchObject({ state: 'pending', source: 'control_plane', planNodeKey: 'confirm-network' });
    await expect(interactions.respond({ taskId: 'task-interaction', interactionId: created.id, response: { internetAccess: true, allowedDomains: ['openai.com'] }, message: '仅用于资料检索', idempotencyKey: 'answer-network-1' })).resolves.toMatchObject({ accepted: true, state: 'answered' });
    await expect(interactions.respond({ taskId: 'task-interaction', interactionId: created.id, response: { internetAccess: false }, idempotencyKey: 'answer-network-1' })).resolves.toMatchObject({ accepted: true, state: 'answered' });
    await expect(interactions.claimResume({ taskId: 'task-interaction', interactionId: created.id })).resolves.toMatchObject({ claimed: true, state: 'resumed' });
    await expect(interactions.claimResume({ taskId: 'task-interaction', interactionId: created.id })).resolves.toMatchObject({ claimed: false, state: 'resumed' });
    await expect(workspaces.resolveTaskPath('task-interaction', join('interactions', created.id, 'answer.json'))).resolves.toContain(created.id);
  });

  it('rejects a response outside the stored schema without changing a pending request', async () => {
    const { interactions } = await environment();
    const created = await interactions.requestPlanInteraction({ taskId: 'task-interaction', planNodeKey: 'confirm-network', request });

    await expect(interactions.respond({ taskId: 'task-interaction', interactionId: created.id, response: { allowedDomains: ['openai.com'], unexpected: true }, idempotencyKey: 'invalid-answer-1' })).rejects.toThrow(/internetAccess|unexpected/i);
    expect(await interactions.pendingForTask('task-interaction')).toEqual([expect.objectContaining({ id: created.id, state: 'pending' })]);
  });
});
