import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskRecoveryService } from '../../apps/control-plane/src/tasks/task-recovery.service';
import { TaskSchedulerService, type NodeManagerLauncher } from '../../apps/control-plane/src/tasks/task-scheduler.service';
import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const roots: string[] = [];
beforeAll(async () => { await dataSource.initialize(); });
afterAll(async () => { await dataSource.destroy(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('TaskRecoveryService', () => {
  it('requeues a task that was left in planning before a compiled graph existed', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'task-planning' }]);
    const orchestration = { enqueue: vi.fn() };
    const recovery = new (TaskRecoveryService as any)(
      { query },
      { advance: vi.fn() },
      { append: vi.fn() },
      orchestration,
    );

    await recovery.recoverInterrupted();

    expect(orchestration.enqueue).toHaveBeenCalledWith('task-planning');
  });

  it('marks expired leases interrupted and starts exactly one fresh attempt without touching accepted work', async () => {
    await dataSource.dropDatabase(); await dataSource.runMigrations();
    const root = await mkdtemp(join(tmpdir(), 'mg-recovery-')); roots.push(root);
    const workspaces = new TaskWorkspaceService({ root });
    const task = await workspaces.create({ id: 'task-recover', goal: '恢复任务', acceptanceMode: 'platform_auto' });
    await dataSource.query(`INSERT INTO tasks (id,goal,acceptance_mode,state,workspace_path) VALUES ('task-recover','恢复任务','platform_auto','running',$1),('task-done','已完成','platform_auto','accepted',$2)`, [task.root, join(root, 'task-done')]);
    await dataSource.query(`INSERT INTO task_plans (id,task_id,version,plan,state) VALUES ('plan-recover','task-recover',1,$1::jsonb,'compiled')`, [JSON.stringify(plan())]);
    await dataSource.query(`INSERT INTO task_nodes (id,plan_id,node_key,state,input,capability,agent_id,agent_version,depends_on,workspace_path) VALUES ('node-recover','plan-recover','retrieve','running','{}','knowledge.retrieve','ragflow-knowledge','1.0.0','[]'::jsonb,$1)`, [join(task.root, 'nodes', 'retrieve')]);
    await dataSource.query(`INSERT INTO task_attempts (id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state) VALUES ('attempt-old','node-recover','instance-old',1,'expired-lease-token-with-at-least-24-chars',now()-interval '1 minute','leased')`);
    const launcher: NodeManagerLauncher = { startInstance: vi.fn(async (input) => ({ instanceId: input.instanceId, unitName: `mg-${input.instanceId}` })), stopInstance: vi.fn() };
    const scheduler = new TaskSchedulerService(dataSource, workspaces, new TaskSessionService(workspaces), launcher, { workspaceRoot: root, callbackBaseUrl: 'http://127.0.0.1:3010', runtimeRoot: join(root, 'runtime'), leaseSeconds: 120 });

    await new TaskRecoveryService(dataSource, scheduler, new TaskSessionService(workspaces)).recoverInterrupted();

    expect(launcher.startInstance).toHaveBeenCalledTimes(1);
    expect(await dataSource.query(`SELECT state FROM task_attempts WHERE id='attempt-old'`)).toEqual([{ state: 'interrupted' }]);
    expect(await dataSource.query(`SELECT attempt_number, state FROM task_attempts WHERE task_node_id='node-recover' ORDER BY attempt_number`)).toEqual([{ attempt_number: 1, state: 'interrupted' }, { attempt_number: 2, state: 'leased' }]);
  });
});

function plan() { return { version: 'v1', nodes: [{ id: 'retrieve', type: 'agent_call', capability: 'knowledge.retrieve', agentId: 'ragflow-knowledge', agentVersion: '1.0.0', input: { query: '恢复' }, workspace: { mode: 'isolated' } }, { id: 'finish', type: 'end', dependsOn: ['retrieve'] }] }; }
