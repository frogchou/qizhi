import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskArtifactService } from '../../apps/control-plane/src/tasks/task-artifact.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const roots: string[] = [];

beforeAll(async () => { await dataSource.initialize(); });
afterAll(async () => { await dataSource.destroy(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('TaskArtifactService', () => {
  it('keeps each verified artifact revision immutable when a node produces a replacement', async () => {
    const { root, workspace, nodeWorkspace, service } = await environment();
    const report = join(nodeWorkspace, 'report.txt');
    await writeFile(report, 'first delivery');

    const first = await service.archiveVerifiedArtifacts({ taskId: 'task-artifact', taskNodeId: 'node-artifact', taskAttemptId: 'attempt-one', nodeWorkspace, artifacts: [{ path: 'report.txt', sha256: sha256('first delivery') }] });
    await writeFile(report, 'improved delivery');
    const second = await service.archiveVerifiedArtifacts({ taskId: 'task-artifact', taskNodeId: 'node-artifact', taskAttemptId: 'attempt-two', nodeWorkspace, artifacts: [{ path: 'report.txt', sha256: sha256('improved delivery') }] });

    expect(first).toMatchObject([{ revision: 1, fileName: 'report.txt', mediaType: 'text/plain; charset=utf-8' }]);
    expect(second).toMatchObject([{ revision: 2, fileName: 'report.txt', mediaType: 'text/plain; charset=utf-8' }]);
    expect(await readFile(join(root, 'task-artifact', first[0].storagePath), 'utf8')).toBe('first delivery');
    expect(await readFile(join(root, 'task-artifact', second[0].storagePath), 'utf8')).toBe('improved delivery');
  });
});

async function environment() {
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  const root = await mkdtemp(join(tmpdir(), 'mg-artifact-'));
  roots.push(root);
  const workspace = new TaskWorkspaceService({ root });
  const task = await workspace.create({ id: 'task-artifact', goal: '生成可下载交付物', acceptanceMode: 'platform_auto' });
  const nodeWorkspace = await workspace.createNodeWorkspace('task-artifact', 'produce');
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-artifact','生成可下载交付物','platform_auto','running',$1)`, [task.root]);
  await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('plan-artifact','task-artifact',1,$1::jsonb,'compiled')`, [JSON.stringify({ version: 'v1', nodes: [] })]);
  await dataSource.query(`INSERT INTO task_nodes (id, plan_id, node_key, state, input, capability, agent_id, agent_version, depends_on, workspace_path) VALUES ('node-artifact','plan-artifact','produce','completed','{}','document.produce','test-agent','1.0.0','[]'::jsonb,$1)`, [nodeWorkspace]);
  await dataSource.query(`INSERT INTO task_attempts (id, task_node_id, instance_id, attempt_number, lease_token, lease_expires_at, state) VALUES ('attempt-one','node-artifact','instance-one',1,'lease-token-one-with-at-least-24-chars',now()+interval '5 minutes','completed'), ('attempt-two','node-artifact','instance-two',2,'lease-token-two-with-at-least-24-chars',now()+interval '5 minutes','completed')`);
  return { root, workspace, nodeWorkspace, service: new TaskArtifactService(dataSource, workspace) };
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
