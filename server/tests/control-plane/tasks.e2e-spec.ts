import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { requiredTestDatabaseUrl } from './test-database';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';

const token = 'task-api-administrator-token';
const tokenHash = createHash('sha256').update(token).digest('hex');
const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
let app: NestFastifyApplication;
let workspaceRoot: string;
const stopInstance = vi.fn();

describe('task creation API', () => {
  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'mg-task-api-'));
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    app = await NestFactory.create(AppModule.register({
      dataSource,
      adminTokenHash: tokenHash,
      nodeManager: { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn(), startInstance: vi.fn(), stopInstance } as any,
      taskRuntime: { ragflowBaseUrl: 'http://invalid', ragflowApiKey: '', datasetIds: [], workspaceRoot },
    }), new FastifyAdapter());
    await app.getHttpAdapter().getInstance().register(multipart, { limits: { files: 1, fileSize: 1024 * 1024 } });
    await app.init();
  });

  it('stops a waiting task through the guarded API and accepts repeated stop requests', async () => {
    const taskId = 'task-stop-api';
    await app.get(TaskWorkspaceService)
      .create({ id: taskId, goal: '测试终止', acceptanceMode: 'platform_auto' });
    await dataSource.query("INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path) VALUES ($1,'测试终止','awaiting_user_input','platform_auto',$2)", [taskId, join(workspaceRoot,taskId)]);
    await dataSource.query("INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('stop-plan',$1,1,'{}','compiled')", [taskId]);
    await dataSource.query("INSERT INTO task_nodes (id,plan_id,node_key,state) VALUES ('stop-node','stop-plan','lookup','running')");
    await dataSource.query("INSERT INTO task_attempts (id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state) VALUES ('stop-attempt','stop-node','stop-instance',1,'test',now()+interval '5 minutes','leased')");
    const url = `/v1/tasks/${taskId}/stop`;
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    stopInstance.mockRejectedValueOnce(new Error('node temporarily unavailable'));
    const retryable = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } });
    expect(retryable.statusCode).toBe(409);
    expect(retryable.json().code).toBe('task_stop_pending');
    expect((await dataSource.query('SELECT state FROM tasks WHERE id=$1', [taskId]))[0].state).toBe('stopping');
    for (let i = 0; i < 2; i++) {
      const reply = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ state: 'cancelled' });
    }
    expect(stopInstance).toHaveBeenCalledTimes(2);
    expect(stopInstance).toHaveBeenCalledWith('stop-instance');
  });

  it('protects the historical decision if a user stops an already accepted task', async () => {
    await dataSource.query("INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path) VALUES ('task-stop-finished','已经验收','accepted','human_review',$1)", [join(workspaceRoot,'task-stop-finished')]);
    const reply=await app.inject({method:'POST',url:'/v1/tasks/task-stop-finished/stop',headers:{authorization:`Bearer ${token}`}});
    expect(reply.statusCode).toBe(409);
    expect(reply.json().code).toBe('task_already_finished');
    expect((await dataSource.query("SELECT state FROM tasks WHERE id='task-stop-finished'"))[0].state).toBe('accepted');
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('persists a user requirement and returns immediately while planning continues in the background', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: '制作438c项目介绍PPT', acceptanceMode: 'platform_auto', sourceSystem: 'qizhi_desktop' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ taskId: string; state: string }>();
    expect(body).toMatchObject({ taskId: expect.any(String), state: 'planning' });
    expect((await dataSource.query('SELECT source_system FROM tasks WHERE id=$1', [body.taskId]))[0].source_system).toBe('qizhi_desktop');
    const unsupported = await app.inject({ method: 'POST', url: '/v1/tasks', headers: { authorization: `Bearer ${token}` }, payload: { goal: 'origin', sourceSystem: 'wechat' } });
    expect(unsupported.statusCode).toBe(400);
    expect((await dataSource.query<{ goal: string; workspacePath: string }[]>(`SELECT goal, workspace_path AS "workspacePath" FROM tasks WHERE id=$1`, [body.taskId]))[0].goal).toBe('制作438c项目介绍PPT');
    await expect(stat(join(workspaceRoot, body.taskId, 'task.json'))).resolves.toBeDefined();

    const detail = await app.inject({ method: 'GET', url: `/v1/tasks/${body.taskId}`, headers: { authorization: `Bearer ${token}` } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ activities: Array<{ kind: string; message: string }> }>().activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'task_received', message: expect.stringContaining('已接收需求信号') }),
    ]));
  });

  it('never exposes a leased agent token in task detail', async () => {
    await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-safe','safe','platform_auto','running',$1)`, [join(workspaceRoot, 'task-safe')]);
    await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('plan-safe','task-safe',1,'{}'::jsonb,'compiled')`);
    await dataSource.query(`INSERT INTO task_nodes (id, plan_id, node_key, state) VALUES ('node-safe','plan-safe','safe','running')`);
    await dataSource.query(`INSERT INTO task_attempts (id, task_node_id, instance_id, attempt_number, lease_token, lease_expires_at, state) VALUES ('attempt-safe','node-safe','instance-safe',1,'lease-token-that-must-never-reach-the-browser',now()+interval '5 minutes','leased')`);

    const detail = await app.inject({ method: 'GET', url: '/v1/tasks/task-safe', headers: { authorization: `Bearer ${token}` } });

    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('lease-token-that-must-never-reach-the-browser');
  });

  it('freezes an uploaded private file into its task and serves only the frozen copy', async () => {
    const originalName = '项目资料.txt';
    const originalContent = '栖知是一套企业知识与智能体协作平台。';
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/task-inputs/uploads',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=task-input-boundary' },
      payload: multipartPayload('task-input-boundary', originalName, 'text/plain; charset=utf-8', originalContent),
    });

    expect(upload.statusCode).toBe(201);
    const uploadId = upload.json<{ upload: { id: string; sha256: string; sizeBytes: number } }>().upload.id;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { goal: '基于附件制作栖知介绍', acceptanceMode: 'human_review', inputIds: [uploadId] },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ taskId: string }>().taskId;
    expect((await dataSource.query('SELECT source_system FROM tasks WHERE id=$1', [taskId]))[0].source_system).toBe('api');

    const rows = await dataSource.query<Array<{ workspace_relative_path: string; sha256: string }>>(
      `SELECT workspace_relative_path, sha256 FROM task_inputs WHERE task_id=$1`, [taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sha256).toBe(createHash('sha256').update(originalContent).digest('hex'));
    await expect(readFile(join(workspaceRoot, taskId, rows[0].workspace_relative_path), 'utf8')).resolves.toBe(originalContent);

    const detail = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { authorization: `Bearer ${token}` } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ inputs: Array<{ id: string; displayName: string; originalFilename: string }> }>().inputs).toEqual([
      expect.objectContaining({ displayName: originalName, originalFilename: originalName }),
    ]);

    const inputId = detail.json<{ inputs: Array<{ id: string }> }>().inputs[0].id;
    const download = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/inputs/${inputId}/download`, headers: { authorization: `Bearer ${token}` } });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(originalContent);
    expect(download.headers['content-disposition']).toContain('attachment');
  });

  it('retains basket provenance on immutable inputs and rejects partial origin labels', async () => {
    const basketId='9e0ef66f-eab5-4c1c-a6b8-5d6c8aa53a37';
    const headers={authorization:`Bearer ${token}`,'content-type':'multipart/form-data; boundary=origin-boundary'};
    const payload=multipartPayload('origin-boundary','资料片段.md','text/markdown','项目片段正文');
    const path='/v1/task-inputs/uploads';
    const invalid=await app.inject({method:'POST',url:path,headers:{...headers,'x-qizhi-source-type':'ragflow_chunk'},payload});
    expect(invalid.statusCode).toBe(400);
    const staged=await app.inject({method:'POST',url:path,headers:{...headers,'x-qizhi-source-type':'ragflow_chunk','x-qizhi-basket-id':basketId},payload});
    expect(staged.statusCode).toBe(201);
    const {upload}=staged.json();
    expect(upload).toMatchObject({sourceType:'ragflow_chunk',provenance:{basketItemId:basketId}});
    const created=await app.inject({method:'POST',url:'/v1/tasks',headers:{authorization:`Bearer ${token}`},payload:{goal:'使用资料筐片段',acceptanceMode:'human_review',inputIds:[upload.id]}});
    expect(created.statusCode).toBe(201);
    const detail=await app.inject({method:'GET',url:'/v1/tasks/'+created.json().taskId,headers:{authorization:`Bearer ${token}`}});
    expect(detail.json().inputs[0]).toMatchObject({sourceType:'ragflow_chunk',provenance:{basketItemId:basketId,uploadId:upload.id}});
  });
});

function multipartPayload(boundary: string, fileName: string, mediaType: string, content: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n${content}\r\n--${boundary}--\r\n`;
}
