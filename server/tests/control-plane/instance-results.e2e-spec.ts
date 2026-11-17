import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskInteractionService } from '../../apps/control-plane/src/tasks/task-interaction.service';
import { TaskSchedulerService } from '../../apps/control-plane/src/tasks/task-scheduler.service';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const leaseToken = 'result-lease-token-with-at-least-24-characters';
let app: NestFastifyApplication;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mg-result-'));
  const workspace = join(root, 'task-result', 'nodes', 'produce');
  await writeFile(join(root, '.keep'), '');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }));
  await writeFile(join(workspace, 'report.txt'), 'verified report');
  await dataSource.initialize(); await dataSource.dropDatabase(); await dataSource.runMigrations();
  await dataSource.query(`INSERT INTO tasks (id,goal,acceptance_mode,state,workspace_path) VALUES ('task-result','生成报告','platform_auto','running',$1)`, [join(root, 'task-result')]);
  await dataSource.query(`INSERT INTO task_plans (id,task_id,version,plan,state) VALUES ('plan-result','task-result',1,$1::jsonb,'compiled')`, [JSON.stringify({ version: 'v1', nodes: [{ id: 'produce', type: 'agent_call', capability: 'document.produce', agentId: 'test-agent', agentVersion: '1.0.0', input: {}, workspace: { mode: 'isolated' } }, { id: 'finish', type: 'end', dependsOn: ['produce'] }] })]);
  await dataSource.query(`INSERT INTO task_nodes (id,plan_id,node_key,state,input,capability,agent_id,agent_version,depends_on,workspace_path) VALUES ('node-result','plan-result','produce','running','{}','document.produce','test-agent','1.0.0','[]'::jsonb,$1)`, [workspace]);
  await dataSource.query(`INSERT INTO task_attempts (id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state) VALUES ('attempt-result','node-result','instance-result',1,$1,now()+interval '5 minutes','leased')`, [leaseToken]);
  app = await NestFactory.create(AppModule.register({ acceptanceRunner:{run:async (input)=>({lastMessage:JSON.stringify({items:input.outputSchemaPath?.includes('criteria')?[{requirement:'生成报告',basis:'生成报告',priority:'required'}]:[{id:'R1',status:'met',reason:'报告已归档',evidenceIds:['E1']}]})})}, dataSource, adminTokenHash: '0'.repeat(64), nodeManager: { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn(), startInstance: vi.fn(async (input) => ({ instanceId: input.instanceId, unitName: `test-${input.instanceId}` })), stopInstance: vi.fn() } as any, taskRuntime: { ragflowBaseUrl: 'http://invalid', ragflowApiKey: '', datasetIds: [], workspaceRoot: root } }), new FastifyAdapter());
  await app.init();
});
afterAll(async () => { await app.close(); await dataSource.destroy(); await rm(root, { recursive: true, force: true }); });

describe('instance result API', () => {
  it('accepts only an active leased, checksummed result and advances the durable task', async () => {
    const result = resultPayload();
    const wrongLease = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken: 'wrong-result-lease-token-xxxxxxxx', result } });
    expect(wrongLease.statusCode).toBe(403);
    const accepted = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken, result } });
    expect(accepted.statusCode).toBe(201);
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM tasks WHERE id='task-result'`))[0].state).toBe('accepted');
    expect(await dataSource.query<{ kind: string; state: string; source: string }[]>(`SELECT kind, state, source FROM task_activity_events WHERE task_id='task-result'`)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent_result', state: 'completed', source: 'agent' })]));
    const artifacts = await dataSource.query<Array<{ original_path: string; storage_path: string; revision: number; media_type: string }>>(`SELECT original_path, storage_path, revision, media_type FROM task_artifacts WHERE task_id='task-result'`);
    expect(artifacts).toEqual([expect.objectContaining({ original_path: 'report.txt', revision: 1, media_type: 'text/plain; charset=utf-8' })]);
    expect(await readFile(join(root, 'task-result', artifacts[0].storage_path), 'utf8')).toBe('verified report');
    expect((await dataSource.query<Array<{ result: { artifacts: Array<{ path: string }> } }>>(`SELECT result FROM task_attempts WHERE id='attempt-result'`))[0].result.artifacts).toEqual([{ path: 'report.txt', sha256: createHash('sha256').update('verified report').digest('hex') }]);
    const duplicate = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken, result } });
    expect(duplicate.statusCode).toBe(409);
  });

  it('rejects an artifact whose SHA-256 does not match the task-local file', async () => {
    await dataSource.query(`UPDATE task_attempts SET state='leased', lease_expires_at=now()+interval '5 minutes', result_received_at=NULL WHERE id='attempt-result'`);
    await dataSource.query(`UPDATE task_nodes SET state='running', output=NULL WHERE id='node-result'`);
    const result = resultPayload(); result.artifacts[0].sha256 = '0'.repeat(64);
    const response = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken, result } });
    expect(response.statusCode).toBe(400);
  });

  it('yields a leased agent for user input, then resumes it as a new attempt with a sealed checkpoint', async () => {
    const workspace = join(root, 'task-result', 'nodes', 'produce');
    const checkpointContent = Buffer.from('{"phase":"awaiting audience"}\n', 'utf8');
    await writeFile(join(workspace, 'checkpoint.json'), checkpointContent);
    await resetLeasedAttempt();

    const response = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken, result: yieldedPayload(checkpointContent) } });
    expect(response.statusCode).toBe(201);
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM tasks WHERE id='task-result'`))[0].state).toBe('awaiting_user_input');
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM task_nodes WHERE id='node-result'`))[0].state).toBe('awaiting_user_input');
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM task_attempts WHERE id='attempt-result'`))[0].state).toBe('yielded');
    const [interaction] = await dataSource.query<Array<{ id: string; source: string; state: string; checkpoint: { workspaceRelativePath: string } }>>(`SELECT id, source, state, checkpoint FROM task_interactions WHERE task_id='task-result'`);
    expect(interaction).toMatchObject({ source: 'agent', state: 'pending', checkpoint: { workspaceRelativePath: 'checkpoints/continue-audience.checkpoint' } });
    await expect(readFile(join(workspace, 'checkpoints', 'continue-audience.checkpoint'))).resolves.toEqual(checkpointContent);
    expect((await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken, result: yieldedPayload(checkpointContent) } })).statusCode).toBe(409);

    const interactions = app.get(TaskInteractionService);
    await interactions.respond({ taskId: 'task-result', interactionId: interaction.id, response: { decision: 'confirm' }, idempotencyKey: 'yield-answer-1' });
    await app.get(TaskSchedulerService).resumeInteraction('task-result', interaction.id);
    const attempts = await dataSource.query<Array<{ attempt_number: number; state: string }>>(`SELECT attempt_number, state FROM task_attempts WHERE task_node_id='node-result' ORDER BY attempt_number`);
    expect(attempts).toEqual([{ attempt_number: 1, state: 'yielded' }, { attempt_number: 2, state: 'leased' }]);
    const resumedEnvelope = JSON.parse(await readFile(join(workspace, 'envelope.json'), 'utf8'));
    expect(resumedEnvelope).toMatchObject({ attemptNumber: 2, resume: { fromInteractionId: interaction.id, checkpoint: { workspaceRelativePath: 'checkpoints/continue-audience.checkpoint' }, answers: [{ interactionId: interaction.id, response: { decision: 'confirm' } }] } });
  });

  it('rejects missing, escaping, or changed checkpoints without yielding the active lease', async () => {
    const workspace = join(root, 'task-result', 'nodes', 'produce');
    const checkpointContent = Buffer.from('{"phase":"awaiting audience"}\n', 'utf8');
    await writeFile(join(workspace, 'checkpoint.json'), checkpointContent);
    for (const checkpoint of [
      { workspaceRelativePath: '../outside.json' },
      { workspaceRelativePath: 'missing.json' },
      { sha256: '0'.repeat(64) },
    ]) {
      await resetLeasedAttempt();
      const response = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-result/result', payload: { leaseToken, result: yieldedPayload(checkpointContent, checkpoint) } });
      expect(response.statusCode).toBe(400);
      expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM task_attempts WHERE id='attempt-result'`))[0].state).toBe('leased');
      expect((await dataSource.query<{ count: string }[]>(`SELECT COUNT(*)::text AS count FROM task_interactions WHERE task_id='task-result'`))[0].count).toBe('0');
    }
  });
});

function resultPayload() {
  return {
    protocolVersion: 'v1', taskId: 'task-result', taskNodeId: 'node-result', instanceId: 'instance-result', status: 'succeeded', output: { message: '报告已生成' }, evidence: [], risks: [],
    artifacts: [{ path: 'report.txt', sha256: createHash('sha256').update('verified report').digest('hex') }],
  };
}

async function resetLeasedAttempt(): Promise<void> {
  await dataSource.query(`DELETE FROM task_interactions WHERE task_id='task-result'`);
  await dataSource.query(`DELETE FROM task_artifacts WHERE task_attempt_id='attempt-result'`);
  await dataSource.query(`UPDATE tasks SET state='running' WHERE id='task-result'`);
  await dataSource.query(`UPDATE task_nodes SET state='running', output=NULL WHERE id='node-result'`);
  await dataSource.query(`UPDATE task_attempts SET state='leased', result=NULL, result_received_at=NULL, lease_expires_at=now()+interval '5 minutes' WHERE id='attempt-result'`);
}

function yieldedPayload(checkpointContent: Buffer, checkpointOverride: Record<string, unknown> = {}) {
  return {
    protocolVersion: 'v1', taskId: 'task-result', taskNodeId: 'node-result', instanceId: 'instance-result', status: 'needs_user_input',
    summary: '需要确认 PPT 面向的受众。',
    interaction: {
      kind: 'confirmation', title: '确认目标受众', prompt: '请确认 PPT 是否面向客户决策者。', responseTarget: 'task.session.audience',
      responseSchema: { type: 'object', required: ['decision'], additionalProperties: false, properties: { decision: { type: 'string', enum: ['confirm', 'revise'] } } },
    },
    checkpoint: { schemaVersion: 1, resumeKey: 'continue-audience', workspaceRelativePath: 'checkpoint.json', sha256: createHash('sha256').update(checkpointContent).digest('hex'), ...checkpointOverride },
  };
}
