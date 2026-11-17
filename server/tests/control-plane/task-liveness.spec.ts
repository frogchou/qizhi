import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskLivenessService } from '../../apps/control-plane/src/tasks/task-liveness.service';
import { OperationalLogger } from '../../apps/control-plane/src/observability/operational-logger';
import { TaskSchedulerService, type NodeManagerLauncher } from '../../apps/control-plane/src/tasks/task-scheduler.service';
import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const roots: string[] = [];
beforeAll(async () => { await dataSource.initialize(); });
afterAll(async () => { await dataSource.destroy(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('TaskLivenessService', () => {
  it('stops a no-heartbeat attempt and gives that node exactly one new attempt', async () => {
    await dataSource.dropDatabase(); await dataSource.runMigrations();
    const root = await mkdtemp(join(tmpdir(), 'mg-liveness-')); roots.push(root);
    const workspaces = new TaskWorkspaceService({ root });
    const task = await workspaces.create({ id: 'task-live', goal: '监督测试', acceptanceMode: 'platform_auto' });
    await dataSource.query(`INSERT INTO tasks (id,goal,acceptance_mode,state,workspace_path) VALUES ('task-live','监督测试','platform_auto','running',$1)`, [task.root]);
    await dataSource.query(`INSERT INTO task_plans (id,task_id,version,plan,state) VALUES ('plan-live','task-live',1,$1::jsonb,'compiled')`, [JSON.stringify(plan())]);
    await dataSource.query(`INSERT INTO task_nodes (id,plan_id,node_key,state,input,capability,agent_id,agent_version,depends_on,workspace_path) VALUES ('node-live','plan-live','retrieve','running','{}','knowledge.retrieve','ragflow-knowledge','1.0.0','[]'::jsonb,$1)`, [join(task.root, 'nodes', 'retrieve')]);
    await dataSource.query(`INSERT INTO task_attempts (id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state,created_at) VALUES ('attempt-live','node-live','instance-live',1,'expired-first-heartbeat-token',now()+interval '5 minutes','leased',now()-interval '2 minutes')`);
    const launcher: NodeManagerLauncher = { startInstance: vi.fn(async (input) => ({ instanceId: input.instanceId, unitName: `mg-agent-${input.instanceId}` })), stopInstance: vi.fn() };
    const scheduler = new TaskSchedulerService(dataSource, workspaces, new TaskSessionService(workspaces), launcher, { workspaceRoot: root, callbackBaseUrl: 'http://127.0.0.1:3010', runtimeRoot: join(root, 'runtime') });
    const activities = { append: vi.fn().mockResolvedValue(undefined) };
    const service = new TaskLivenessService(dataSource, scheduler, launcher, new TaskSessionService(workspaces), activities as any, new OperationalLogger({ write: () => undefined }), { startupGraceMs: 1_000, heartbeatTimeoutMs: 1_000 });

    await service.sweep();

    expect(launcher.stopInstance).toHaveBeenCalledWith('instance-live');
    expect(launcher.startInstance).toHaveBeenCalledTimes(1);
    expect(await dataSource.query(`SELECT attempt_number, state FROM task_attempts WHERE task_node_id='node-live' ORDER BY attempt_number`)).toEqual([{ attempt_number: 1, state: 'interrupted' }, { attempt_number: 2, state: 'leased' }]);
    expect(activities.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_liveness_lost', source: 'control_plane' }));
  });
});

function plan() { return { version: 'v1', nodes: [{ id: 'retrieve', type: 'agent_call', capability: 'knowledge.retrieve', agentId: 'ragflow-knowledge', agentVersion: '1.0.0', input: { query: '监督测试' }, workspace: { mode: 'isolated' } }, { id: 'finish', type: 'end', dependsOn: ['retrieve'] }] }; }
