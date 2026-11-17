import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../apps/control-plane/src/app.module.js';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source.js';
import { RegistryService } from '../../apps/control-plane/src/registry/registry.service.js';
import { requiredTestDatabaseUrl } from './test-database.js';

const db = createControlPlaneDataSource(requiredTestDatabaseUrl());
const token = 'factory-lifecycle-test';
const auth = { authorization: 'Bearer ' + token };
const versionPath = '/v1/factory/agents/brief-writer/versions/1.0.0/offline';
const declaration = {
  intent: 'create',
  template: 'codex-text',
  agentId: 'brief-writer',
  displayName: '简报员',
  version: '1.0.0',
  description: '根据任务简报撰写中文报告',
  instructions: '整理简报，保留出处。',
};
const nodes = { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn(), revokeVersion: vi.fn() };
let app: NestFastifyApplication;
let root: string;
describe('factory version lifecycle', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'qizhi-release-'));
    await db.initialize();
    await db.dropDatabase();
    await db.runMigrations();
    app = await NestFactory.create(
      AppModule.register({
        dataSource: db,
        adminTokenHash: createHash('sha256').update(token).digest('hex'),
        nodeManager: nodes,
        taskRuntime: {
          workspaceRoot: root,
          agentPackageRoot: root,
          ragflowBaseUrl: '',
          ragflowApiKey: '',
          datasetIds: [],
        },
      }),
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  });

  it('creates only a declaration, supports a higher version and rejects an older one', async () => {
    const api = '/v1/factory/releases';
    expect((await app.inject({ method: 'POST', url: api, payload: declaration })).statusCode).toBe(401);
    const publish = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: api, headers: auth, payload: body });
    const created = await publish(declaration);
    expect(created.json()).toMatchObject({
      agentId: 'brief-writer',
      version: '1.0.0',
      status: 'pending_review',
    });
    expect(nodes.requestSelfCheck).not.toHaveBeenCalled();
    const profile = JSON.parse(
      await readFile(join(root, 'qizhi-brief-writer-v1.0.0', 'profile.json'), 'utf8'),
    );
    expect(profile.instructions).toBe(declaration.instructions);
    const packages = await app.inject({ method: 'GET', url: '/v1/factory/packages', headers: auth });
    expect(packages.json().items).toContainEqual(
      expect.objectContaining({ packageName: 'qizhi-brief-writer-v1.0.0', status: 'pending_review' }),
    );
    expect((await publish({ ...declaration, intent: 'upgrade', version: '0.9.2' })).statusCode).toBe(409);
    expect((await publish({ ...declaration, intent: 'upgrade', version: '1.0.1' })).json()).toMatchObject({
      version: '1.0.1',
      status: 'pending_review',
    });
    expect((await publish({ intent: 'create', packageName: '../elsewhere' })).statusCode).toBe(400);
  });
  it('recovers a failed revoke, remains offline after re-discovery and requires approval to enable again', async () => {
    const approve = () =>
      app.inject({ method: 'POST', url: '/v1/agents/brief-writer/versions/1.0.0/approve', headers: auth });
    const offline = () => app.inject({ method: 'POST', url: versionPath, headers: auth });
    expect((await approve()).json()).toMatchObject({ status: 'ready' });
    nodes.revokeVersion.mockRejectedValueOnce(new Error('node manager unavailable'));
    expect((await offline()).statusCode).toBeGreaterThanOrEqual(500);
    const state = async () =>
      (await db.query("SELECT status FROM agent_versions WHERE id='brief-writer@1.0.0'"))[0].status;
    expect(await state()).toBe('draining');
    await app.get(RegistryService).recoverVersionChanges();
    const attempts = nodes.revokeVersion.mock.calls.length;
    expect((await offline()).json()).toMatchObject({ status: 'offline' });
    expect(nodes.revokeVersion).toHaveBeenCalledTimes(attempts);
    await app.get(RegistryService).discover(join(root, 'qizhi-brief-writer-v1.0.0'), 'system');
    expect(await state()).toBe('offline');
    expect((await approve()).json()).toMatchObject({ status: 'ready' });
    expect(nodes.requestSelfCheck).toHaveBeenCalledTimes(2);
  });
  it('blocks bound plans, supplemental work and active leases, then tombstones all versions and recovers a partial revoke', async () => {
    const url = '/v1/factory/agents/brief-writer/delete';
    const remove = () => app.inject({ method: 'POST', url, headers: auth });
    const state = async () => (await app.inject({ method: 'GET', url: '/v1/factory/agents/brief-writer/status', headers: auth })).json();
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    await db.query("INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path,current_plan_version) VALUES ('bound','test','planned','human_review','/workspace',1)");
    await db.query(`INSERT INTO task_plans(id,task_id,version,plan,state) VALUES
      ('bound-plan','bound',1,'{"nodes":[{"id":"write","type":"agent_call","agentId":"brief-writer","agentVersion":"1.0.0"}]}','compiled')`);
    expect((await remove()).json()).toMatchObject({ code: 'agent_in_use', taskIds: ['bound'] });
    expect(await state()).toMatchObject({ status: 'active' });
    await db.query("UPDATE task_plans SET plan='{}'");
    await db.query(`INSERT INTO task_acceptance_rounds (id,task_id,round,criteria,assessment,decision,supplement_node)
      VALUES ('00000000-0000-4000-8000-000000000041','bound',1,'[]','{}','supplement','{"agentId":"brief-writer","agentVersion":"1.0.1"}')`);
    expect((await remove()).statusCode).toBe(409);
    await db.query("UPDATE tasks SET state='accepted' WHERE id='bound'");
    await db.query("INSERT INTO task_nodes(id,plan_id,node_key,state,agent_id,agent_version) VALUES ('history','bound-plan','work','completed','brief-writer','1.0.0')");
    await db.query(`INSERT INTO task_attempts(id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state) VALUES
      ('job','history','instance',1,'private',now()+interval '1 minute','leased')`);
    expect((await remove()).json()).toMatchObject({ code: 'agent_in_use', taskIds: ['bound'] });
    await db.query("UPDATE task_attempts SET state='completed'");
    nodes.revokeVersion.mockRejectedValueOnce(new Error('credentials unavailable for test'));
    expect((await remove()).json()).toMatchObject({ code: 'agent_delete_incomplete' });
    expect(await state()).toMatchObject({ status: 'deleting', versionCount: 2 });
    const visible = () => app.inject({ method: 'GET', url: '/v1/factory/agents?agentId=brief-writer', headers: auth });
    expect((await visible()).json()).toMatchObject({ total: 2, items: [{ status: 'deleting' }, { status: 'deleting' }] });
    await app.get(RegistryService).recoverVersionChanges();
    expect((await remove()).json()).toMatchObject({ status: 'deleted', versionCount: 2 });
    expect((await visible()).json()).toMatchObject({ total: 0 });
    expect((await app.inject({ method: 'GET', url: '/v1/factory/overview', headers: auth })).json().areas.line.metrics.agents).toBe(0);
    expect(await db.query("SELECT agent_id FROM task_nodes WHERE id='history'")).toEqual([{ agent_id: 'brief-writer' }]);
    expect((await db.query("SELECT id FROM task_acceptance_rounds WHERE task_id='bound'")).length).toBe(1);
    const deliveries = await app.inject({ method: 'GET', url: '/v1/factory/deliveries?taskId=bound', headers: auth });
    expect(deliveries.json()).toMatchObject({ total: 1 });
    expect(await readFile(join(root,'qizhi-brief-writer-v1.0.0','profile.json'),'utf8')).toContain('instructions');
    expect(await app.get(RegistryService).discover(join(root,'qizhi-brief-writer-v1.0.0'),'system')).toMatchObject({status:'deleted'});
    const catalog=await app.inject({method:'GET',url:'/v1/factory/packages',headers:auth});
    expect(catalog.json().items).not.toContainEqual(expect.objectContaining({version:'1.0.0'}));
    expect((await app.inject({method:'POST',url:'/v1/agents/brief-writer/versions/1.0.0/approve',headers:auth})).statusCode).toBe(409);
    const release = (payload: object) => app.inject({method:'POST',url:'/v1/factory/releases',headers:auth,payload});
    expect((await release({intent:'create',packageName:'qizhi-brief-writer-v1.0.0'})).statusCode).toBe(409);
    expect((await release({...declaration,version:'0.0.1'})).statusCode).toBe(409);
    expect((await release({...declaration,version:'2.0.0'})).json()).toMatchObject({status:'pending_review'});
    expect(await state()).toMatchObject({status:'active',versionCount:1});
    expect((await visible()).json()).toMatchObject({total:1,items:[{version:'2.0.0',status:'pending_review'}]});
    expect(await app.get(RegistryService).discover(join(root,'qizhi-brief-writer-v1.0.0'),'system')).toMatchObject({status:'deleted'});
    expect(await db.query("SELECT action FROM audit_events WHERE action IN ('agent.deleted','agent.restored') ORDER BY id"))
      .toEqual([{action:'agent.deleted'},{action:'agent.restored'}]);
  });
  it('rejects deletion while approval runs, and cannot overlook a binding transaction that commits during deletion', async () => {
    const agentId = 'concurrent-writer';
    await app.inject({ method:'POST',url:'/v1/factory/releases',headers:auth,payload:{...declaration,agentId} });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve=>{ enter=resolve; });
    const gate = new Promise<void>(resolve=>{ release=resolve; });
    nodes.requestSelfCheck.mockImplementationOnce(async()=>{ enter(); await gate; });
    const approval = app.get(RegistryService).approve(agentId,'1.0.0');
    const url = '/v1/factory/agents/' + agentId + '/delete';
    const remove = ()=>app.inject({method:'POST',url,headers:auth});
    try {
      await entered;
      expect((await remove()).json()).toMatchObject({code:'agent_busy'});
    } finally { release(); await approval; }

    const writer=db.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    try {
      await writer.query("SELECT id FROM agent_versions WHERE agent_id=$1 AND status='ready' FOR SHARE",[agentId]);
      await writer.query("INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path,current_plan_version) VALUES ('race','bound','planned','platform_auto','/workspace',1)");
      await writer.query(`INSERT INTO task_plans(id,task_id,version,plan,state) VALUES ('race-plan','race',1,$1::jsonb,'compiled')`,
        [JSON.stringify({nodes:[{id:'node',agentId,agentVersion:'1.0.0'}]})]);
      const deletion = remove();
      await writer.commitTransaction();
      expect((await deletion).json()).toMatchObject({code:'agent_in_use',taskIds:['race']});
    } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); await writer.release(); }
    await db.query(`INSERT INTO task_nodes(id,plan_id,node_key,agent_id,agent_version,capability,state)
      VALUES ('done','race-plan','node',$1,'1.0.0','presentation.create','completed'),
        ('qc','race-plan','quality',NULL,NULL,'quality.define_and_verify','pending')`,[agentId]);
    await db.query(`UPDATE task_nodes SET depends_on='["node"]' WHERE id='qc'`);
    // A finished PPT still has a potential rework dependency until its quality node succeeds.
    expect((await remove()).json()).toMatchObject({code:'agent_in_use',taskIds:['race']});
    await db.query(`UPDATE task_nodes SET state='completed',output='{"status":"succeeded","output":{"passed":true}}' WHERE id='qc'`);
    // Other work on this task may continue. Its historical, unrepeatable binding is retained.
    expect((await remove()).json()).toMatchObject({status:'deleted'});
  });
});
