import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { requiredTestDatabaseUrl } from './test-database';

const db = createControlPlaneDataSource(requiredTestDatabaseUrl());
const token = 'factory-test-operator';
const headers = { authorization: `Bearer ${token}` };
let app: NestFastifyApplication;
async function get(path: string) {
  const response = await app.inject({ method: 'GET', url: '/v1/factory/' + path, headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe('authenticated factory projections', () => {
  beforeAll(async () => {
    await db.initialize();
    await db.dropDatabase();
    await db.runMigrations();
    app = await NestFactory.create(AppModule.register({
      dataSource: db, adminTokenHash: createHash('sha256').update(token).digest('hex'),
      nodeManager: { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn() },
    }), new FastifyAdapter());
    await app.init();
    await db.query(`INSERT INTO tasks(id, goal, acceptance_mode, state, workspace_path, source_system, created_at)
      SELECT 't-'||i, 'request '||i, 'platform_auto',
        CASE i WHEN 1 THEN 'planning' WHEN 2 THEN 'awaiting_review' WHEN 3 THEN 'failed' WHEN 4 THEN 'accepted'
          WHEN 5 THEN 'running' ELSE 'cancelled' END, '/unneeded',
        CASE i WHEN 2 THEN 'qizhi_desktop' WHEN 3 THEN 'api' ELSE NULL END,
        now() - (61-i)*interval '1 minute' FROM generate_series(1,60) i`);
    await db.query(`INSERT INTO task_acceptance_rounds (id,task_id,round,criteria,assessment,decision) VALUES
      ('00000000-0000-4000-8000-000000000001','t-2',1,'[]','{"items":[{"status":"missing"}],"review":true}',NULL),
      ('00000000-0000-4000-8000-000000000002','t-4',1,'[]','{"items":[{"status":"met"}],"review":false}',NULL)`);
    await db.query(`INSERT INTO agents(id,display_name) VALUES ('retriever','检索')`);
    await db.query(`INSERT INTO agent_versions(id,agent_id,version,status,manifest,approved_at) VALUES
      ('retriever@1.0.0','retriever','1.0.0','ready','{"runtime":"native","capabilities":[{"name":"knowledge.retrieve","description":"检索","token":"private"}],"packagePath":"/secret-path","entryCommand":["private-cmd"]}',now())`);
    await db.query(`INSERT INTO task_plans(id,task_id,version,plan,state) VALUES ('plan','t-5',1,'{}','active')`);
    await db.query(`UPDATE tasks SET current_plan_version=1 WHERE id='t-5'`);
    await db.query(`INSERT INTO task_nodes(id,plan_id,node_key,capability,agent_id,agent_version,state)
      VALUES ('node','plan','lookup','knowledge.retrieve','retriever','1.0.0','running')`);
    await db.query(`INSERT INTO task_attempts(id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state,last_heartbeat_at)
      VALUES ('attempt','node','i',1,'never-display',now()+interval '1 minute','leased',now()-interval '1 hour')`);
    await db.query(`UPDATE tasks SET planner_summary='{"mode":"direct_answer","summary":"a text delivery"}' WHERE id='t-4'`);
  });
  afterAll(async () => { await app?.close(); if (db.isInitialized) await db.destroy(); });

  it('requires the operator token for every projection, validates paging and cursors', async () => {
    for (const page of ['overview','tasks','agents','quality','assets','runtimes','sources','monitor','deliveries','changes']) {
      expect((await app.inject({ method: 'GET', url: '/v1/factory/' + page })).statusCode).toBe(401);
    }
    for (const path of ['tasks?limit=-1','monitor?offset=0.5','changes?after=not-a-cursor','changes?waitMs=25001']) {
      expect((await app.inject({ method: 'GET', url: '/v1/factory/' + path, headers })).statusCode).toBe(400);
    }
  });
  it('finds old active work beyond fifty tasks and preserves source attribution and empty-page totals', async () => {
    expect(await get('overview')).toMatchObject({ areas: {
      intake: { count: 60, metrics: { unknown: 58 } }, control: { count: 3,
        metrics: { activeTasks: 3, planning: 1, running: 1, awaitingReview: 1, accepted: 1 } },
      line: { metrics: { runningAgents: 1, retrievingNodes: 1 } }, monitor: { count: 1 }, delivery: { count: 1 },
    } });
    expect(await get('tasks?area=control')).toMatchObject({ total: 3 });
    expect(await get('tasks?area=control&state=planning')).toMatchObject({ total: 1, items: [{ taskId: 't-1', sourceSystem: 'unknown' }] });
    expect(await get('tasks?offset=99')).toMatchObject({ total: 60, items: [] });
    expect(await get('sources?sourceSystem=qizhi_desktop')).toMatchObject({ items: [{ taskCount: 1, status: 'available' }] });
    expect(await get('sources?sourceSystem=feishu')).toMatchObject({ items: [{ taskCount: 0, status: 'not_connected' }] });
  });
  it('distinguishes recorded quality failures from operational failures and retains file-free deliveries', async () => {
    expect(await get('quality?status=failed')).toMatchObject({ total: 1, items: [{ taskId: 't-2', verdict: 'failed', status: 'pending_review' }] });
    expect(await get('quality?status=automatic_passed')).toMatchObject({ total: 1, items: [{ taskId: 't-4', acceptedBy: 'automatic' }] });
    await db.query("INSERT INTO task_activity_events(task_id,kind,state,message,source) VALUES ('t-5','acceptance_started','running','checking','control_plane')");
    const pending = await get('quality?status=pending_quality');
    expect(pending.total).toBe(2);
    expect(pending.items.map((item:{status:string})=>item.status)).toEqual(['pending_review','checking']);
    expect(await get('deliveries')).toMatchObject({ total: 1, items: [{ taskId: 't-4', artifactCount: 0, answer: 'a text delivery' }] });
  });
  it('retains pre-assessment node answers and quality decisions without inventing an automatic pass', async () => {
    await db.query(`INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path)
      VALUES ('old-delivery','old request','accepted','platform_auto','/unneeded')`);
    await db.query("INSERT INTO task_plans(id,task_id,version,plan,state) VALUES ('old-plan','old-delivery',1,'{}','active')");
    await db.query(`INSERT INTO task_nodes(id,plan_id,node_key,capability,state,output) VALUES
      ('old-node','old-plan','answer','research.web','completed','{"status":"succeeded","output":{"answer":"prior answer"}}'),
      ('old-qc','old-plan','quality','quality.define_and_verify','completed','{"status":"succeeded","output":{"passed":false}}')`);
    await db.query(`INSERT INTO task_activity_events(task_id,kind,state,message,source) VALUES
      ('old-delivery','human_accepted','accepted','reviewed','control_plane')`);
    expect(await get('deliveries?taskId=old-delivery')).toMatchObject({ items: [{ answer: 'prior answer' }] });
    expect(await get('quality?taskId=old-delivery')).toMatchObject({ items: [{ verdict: 'failed', acceptedBy: 'human' }] });
  });
  it('limits catalog and runtime records to operator fields and preserves missing measurements', async () => {
    const versions = await get('agents?status=working');
    expect(versions).toMatchObject({ total: 1, items: [{ agentId: 'retriever', runningCount: 1, capabilities: [{ name: 'knowledge.retrieve' }] }] });
    const jobs = await get('runtimes?agentId=retriever');
    expect(jobs).toMatchObject({ total: 1, items: [{ metrics: { available: false, memoryBytes: null }, taskId: 't-5' }] });
    expect(jobs.inventory).toContainEqual(expect.objectContaining({ id: 'native', readyVersionCount: 1, activeCount: 1 }));
    expect(JSON.stringify([jobs,versions])).not.toMatch(/never-display|secret-path|private-cmd|"token"/);
    expect(await get('assets')).toMatchObject({ total: null, connection: { status: 'unconfigured' } });
  });
  it('replays activities and registry changes after concurrent out-of-order commits', async () => {
    const { cursor } = await get('overview');
    const writer = db.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    const insert = "INSERT INTO task_activity_events(task_id,kind,message,source) VALUES ('t-1',$1,'event','control_plane')";
    try {
      await writer.query(insert, ['early_id']);
      await db.query(insert, ['later_id']);
      const between = await get('changes?after=' + cursor);
      await writer.commitTransaction();
      const delivered = await get('changes?after=' + between.cursor);
      expect([...between.items, ...delivered.items].map((event) => event.kind)).toEqual(['early_id', 'later_id']);
      await db.query("INSERT INTO audit_events(actor,action,payload) VALUES ('admin','agent.offline','{\"agentId\":\"retriever\",\"version\":\"1.0.0\",\"token\":\"private\"}')");
      const audit = await get('changes?after=' + delivered.cursor);
      expect(audit.registryChanges).toMatchObject([{ agentId: 'retriever', action: 'agent.offline' }]);
      expect(JSON.stringify(audit.registryChanges)).not.toContain('private');
      expect((await get('changes?after=' + audit.cursor)).items).toEqual([]);
    } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); await writer.release(); }
  });
});
