import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { requiredTestDatabaseUrl } from './test-database';

const token = 'artifact-download-administrator-token';
const tokenHash = createHash('sha256').update(token).digest('hex');
const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
let app: NestFastifyApplication;
let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'mg-artifact-api-'));
  await dataSource.initialize();
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  const artifactRoot = join(workspaceRoot, 'task-download', 'artifacts', 'nodes', 'node-download', 'revision-1');
  await mkdir(artifactRoot, { recursive: true });
  const content = Buffer.from('presentation binary');
  await writeFile(join(artifactRoot, 'presentation.pptx'), content);
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-download','下载演示稿','platform_auto','accepted',$1), ('task-other','其他任务','platform_auto','accepted',$2)`, [join(workspaceRoot, 'task-download'), join(workspaceRoot, 'task-other')]);
  await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('plan-download','task-download',1,'{}'::jsonb,'compiled'), ('plan-other','task-other',1,'{}'::jsonb,'compiled')`);
  await dataSource.query(`INSERT INTO task_nodes (id, plan_id, node_key, state) VALUES ('node-download','plan-download','produce','completed'), ('node-other','plan-other','produce','completed')`);
  await dataSource.query(`INSERT INTO task_attempts (id, task_node_id, instance_id, attempt_number, lease_token, lease_expires_at, state) VALUES ('attempt-download','node-download','instance-download',1,'artifact-download-lease-token-0001',now()+interval '5 minutes','completed'), ('attempt-other','node-other','instance-other',1,'artifact-other-lease-token-0000001',now()+interval '5 minutes','completed')`);
  await dataSource.query(`INSERT INTO task_artifacts (id, task_id, task_node_id, task_attempt_id, revision, original_path, storage_path, file_name, media_type, sha256, size_bytes) VALUES ('artifact-download','task-download','node-download','attempt-download',1,'presentation.pptx','artifacts/nodes/node-download/revision-1/presentation.pptx','presentation.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',$1,$2)`, [createHash('sha256').update(content).digest('hex'), content.byteLength]);
  app = await NestFactory.create(AppModule.register({ dataSource, adminTokenHash: tokenHash, nodeManager: { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn(), startInstance: vi.fn(), stopInstance: vi.fn() } as any, taskRuntime: { ragflowBaseUrl: 'http://invalid', ragflowApiKey: '', datasetIds: [], workspaceRoot } }), new FastifyAdapter());
  await app.init();
});

afterAll(async () => { await app.close(); await dataSource.destroy(); await rm(workspaceRoot, { recursive: true, force: true }); });

describe('task artifact download API', () => {
  it('lists safe metadata and downloads only a verified artifact belonging to the authenticated task', async () => {
    const detail = await app.inject({ method: 'GET', url: '/v1/tasks/task-download', headers: { authorization: `Bearer ${token}` } });
    expect(detail.statusCode).toBe(200);
    const artifact = detail.json<{ artifacts: Array<Record<string, unknown>> }>().artifacts[0];
    expect(artifact).toMatchObject({ id: 'artifact-download', fileName: 'presentation.pptx', revision: 1 });
    expect(artifact).not.toHaveProperty('storagePath');

    const download = await app.inject({ method: 'GET', url: '/v1/tasks/task-download/artifacts/artifact-download', headers: { authorization: `Bearer ${token}` } });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('presentation binary');
    expect(download.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects anonymous and cross-task artifact reads', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/tasks/task-download/artifacts/artifact-download' });
    expect(anonymous.statusCode).toBe(401);
    const crossTask = await app.inject({ method: 'GET', url: '/v1/tasks/task-other/artifacts/artifact-download', headers: { authorization: `Bearer ${token}` } });
    expect(crossTask.statusCode).toBe(404);
  });
});
