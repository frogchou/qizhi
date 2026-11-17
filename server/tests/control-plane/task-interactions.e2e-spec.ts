import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskInteractionService } from '../../apps/control-plane/src/tasks/task-interaction.service';
import { TaskInputService } from '../../apps/control-plane/src/tasks/task-input.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { requiredTestDatabaseUrl } from './test-database';

const token = 'interaction-administrator-token';
const tokenHash = createHash('sha256').update(token).digest('hex');
const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const nodeManager = { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn(), startInstance: vi.fn(async (input: { instanceId: string }) => ({ instanceId: input.instanceId, unitName: `mg-agent-${input.instanceId}` })), stopInstance: vi.fn() };
let app: NestFastifyApplication;
let workspaceRoot: string;
let taskId: string;
let interactionId: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'mg-interaction-api-'));
  await dataSource.initialize();
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  app = await NestFactory.create(AppModule.register({ dataSource, adminTokenHash: tokenHash, nodeManager: nodeManager as any, taskRuntime: { ragflowBaseUrl: 'http://invalid', ragflowApiKey: '', datasetIds: [], workspaceRoot, callbackBaseUrl: 'http://127.0.0.1:3010' } }), new FastifyAdapter());
  await app.getHttpAdapter().getInstance().register(multipart, { limits: { files: 1, fileSize: 1024 * 1024 } });
  await app.init();
  ({ taskId, interactionId } = await seedWaitingTask());
});

afterAll(async () => { await app.close(); await dataSource.destroy(); await rm(workspaceRoot, { recursive: true, force: true }); });

describe('task interaction API', () => {
  it('requires the administrator token', async () => {
    const response = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/interactions/${interactionId}/respond`, payload: { response: { decision: 'confirm' } } });
    expect(response.statusCode).toBe(401);
  });

  it('accepts one schema-valid answer, resumes only the waiting branch, and makes a same-key retry safe', async () => {
    const detailBefore = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { authorization: `Bearer ${token}` } });
    expect(detailBefore.statusCode).toBe(200);
    expect(detailBefore.json<{ interactions: Array<{ id: string; state: string; title: string }> }>().interactions).toEqual(expect.arrayContaining([expect.objectContaining({ id: interactionId, state: 'pending', title: '确认目标受众' })]));

    const response = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/interactions/${interactionId}/respond`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'answer-confirm-1' }, payload: { response: { decision: 'confirm' }, message: '面向客户决策者。' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ interactionId, state: 'resuming' });
    expect(nodeManager.startInstance).toHaveBeenCalledTimes(1);
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM task_nodes WHERE node_key='confirm-audience'`))[0].state).toBe('completed');
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM task_nodes WHERE node_key='create-presentation'`))[0].state).toBe('running');

    const retry = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/interactions/${interactionId}/respond`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'answer-confirm-1' }, payload: { response: { decision: 'confirm' }, message: '面向客户决策者。' } });
    expect(retry.statusCode).toBe(201);
    expect(nodeManager.startInstance).toHaveBeenCalledTimes(1);

    const conflict = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/interactions/${interactionId}/respond`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'answer-confirm-2' }, payload: { response: { decision: 'confirm' } } });
    expect(conflict.statusCode).toBe(409);
  });

  it('freezes an uploaded answer attachment into the task and the interaction directory before resuming', async () => {
    const next = await seedWaitingTask('task-interaction-attachment');
    const upload = await app.inject({ method: 'POST', url: '/v1/task-inputs/uploads', headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=interaction-boundary' }, payload: multipartPayload('interaction-boundary', '受众说明.txt', 'text/plain', '客户决策者与项目发起人。') });
    expect(upload.statusCode).toBe(201);
    const uploadId = upload.json<{ upload: { id: string } }>().upload.id;

    const response = await app.inject({ method: 'POST', url: `/v1/tasks/${next.taskId}/interactions/${next.interactionId}/respond`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'answer-attachment-1' }, payload: { response: { decision: 'confirm' }, inputIds: [uploadId] } });
    expect(response.statusCode).toBe(201);
    const [input] = await dataSource.query<Array<{ id: string; original_filename: string }>>(`SELECT id, original_filename FROM task_inputs WHERE task_id=$1`, [next.taskId]);
    expect(input).toMatchObject({ original_filename: '受众说明.txt' });
    await expect((await import('node:fs/promises')).readFile(join(workspaceRoot, next.taskId, 'interactions', next.interactionId, 'attachments', input.id, 'original', '受众说明.txt'), 'utf8')).resolves.toBe('客户决策者与项目发起人。');
    expect(await dataSource.query(`SELECT id FROM task_input_audits WHERE task_id=$1 AND task_input_id=$2 AND action='interaction_answer_attachment'`, [next.taskId, input.id])).toHaveLength(1);
  });

  it('reserves a pending interaction before freezing reply attachments, so a concurrent answer cannot create an extra copy', async () => {
    const next = await seedWaitingTask('task-interaction-concurrent-answer');
    const interactions = app.get(TaskInteractionService);
    const inputs = app.get(TaskInputService);
    let markFirstFreezeStarted: (() => void) | undefined;
    const firstFreezeStarted = new Promise<void>((resolve) => { markFirstFreezeStarted = resolve; });
    let releaseFirstFreeze: (() => void) | undefined;
    const firstFreezeBlocked = new Promise<void>((resolve) => { releaseFirstFreeze = resolve; });
    let freezeCalls = 0;
    const freeze = vi.spyOn(inputs, 'freezeForInteractionAnswer').mockImplementation(async () => {
      freezeCalls += 1;
      if (freezeCalls === 1) {
        markFirstFreezeStarted?.();
        await firstFreezeBlocked;
      }
      return [];
    });

    const first = interactions.respond({ taskId: next.taskId, interactionId: next.interactionId, response: { decision: 'confirm' }, inputIds: ['first-upload'], idempotencyKey: 'concurrent-first' });
    await firstFreezeStarted;
    const second = await Promise.allSettled([interactions.respond({ taskId: next.taskId, interactionId: next.interactionId, response: { decision: 'revise' }, inputIds: ['second-upload'], idempotencyKey: 'concurrent-second' })]);
    releaseFirstFreeze?.();
    const firstResult = await Promise.allSettled([first]);
    freeze.mockRestore();

    expect(second[0].status).toBe('rejected');
    expect(firstResult[0].status).toBe('fulfilled');
    expect(freezeCalls).toBe(1);
  });
});

async function seedWaitingTask(id = 'task-interaction'): Promise<{ taskId: string; interactionId: string }> {
  const workspaces = app.get(TaskWorkspaceService);
  const workspace = await workspaces.create({ id, goal: '制作产品介绍', acceptanceMode: 'platform_auto' });
  const planId = `plan-${id}`;
  const nodeId = `node-${id}`;
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ($1,'制作产品介绍','platform_auto','awaiting_user_input',$2)`, [id, workspace.root]);
  const request = { kind: 'confirmation' as const, title: '确认目标受众', prompt: '请确认产品介绍面向的受众。', responseTarget: 'task.session.audience', responseSchema: { type: 'object' as const, required: ['decision'], additionalProperties: false as const, properties: { decision: { type: 'string' as const, enum: ['confirm', 'revise'] } } } };
  const plan = { version: 'v1', nodes: [
    { id: 'confirm-audience', type: 'human_interaction', interaction: request },
    { id: 'create-presentation', type: 'agent_call', capability: 'presentation.create', agentId: 'ppt-maker', agentVersion: '1.0.1', dependsOn: ['confirm-audience'], input: { brief: '产品介绍', title: '产品介绍', referenceMaterials: [] }, workspace: { mode: 'isolated' } },
    { id: 'finish', type: 'end', dependsOn: ['create-presentation'] },
  ] };
  await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ($1,$2,1,$3::jsonb,'compiled')`, [planId, id, JSON.stringify(plan)]);
  await dataSource.query(`INSERT INTO task_nodes (id, plan_id, node_key, node_type, definition, state, input, depends_on, display_title) VALUES ($1,$2,'confirm-audience','human_interaction',$3::jsonb,'awaiting_user_input','{}'::jsonb,'[]'::jsonb,'确认目标受众')`, [nodeId, planId, JSON.stringify(plan.nodes[0])]);
  const interactions = app.get(TaskInteractionService);
  const interaction = await interactions.requestPlanInteraction({ taskId: id, taskPlanId: planId, taskNodeId: nodeId, planNodeKey: 'confirm-audience', request });
  return { taskId: id, interactionId: interaction.id };
}

function multipartPayload(boundary: string, fileName: string, mediaType: string, content: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n${content}\r\n--${boundary}--\r\n`;
}
