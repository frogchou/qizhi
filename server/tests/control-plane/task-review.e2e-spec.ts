import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { requiredTestDatabaseUrl } from './test-database';

const token = 'task-review-administrator-token';
const tokenHash = createHash('sha256').update(token).digest('hex');
const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
let app: NestFastifyApplication;
let workspaceRoot: string;
const nodeManager = { requestSelfCheck: vi.fn(), syncReadyVersion: vi.fn(), startInstance: vi.fn(async (input: { instanceId: string }) => ({ instanceId: input.instanceId, unitName: `mg-agent-${input.instanceId}` })), stopInstance: vi.fn() };

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'mg-review-api-'));
  await dataSource.initialize();
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  await seedFailedPresentation();
  app = await NestFactory.create(AppModule.register({ acceptanceRunner:{run:async(input)=>({lastMessage:JSON.stringify({items:[{id:'R1',status:input.prompt.includes('8.9°C')?'met':'missing',reason:input.prompt.includes('8.9°C')?'补查提供了实测温度':'没有实测温度',evidenceIds:input.prompt.includes('8.9°C')?['E2']:[]}]})})}, dataSource, adminTokenHash: tokenHash, nodeManager: nodeManager as any, taskRuntime: { ragflowBaseUrl: 'http://invalid', ragflowApiKey: '', datasetIds: [], workspaceRoot, callbackBaseUrl: 'http://127.0.0.1:3010' } }), new FastifyAdapter());
  await app.init();
});

afterAll(async () => { await app.close(); await dataSource.destroy(); await rm(workspaceRoot, { recursive: true, force: true }); });

describe('task review API', () => {
  it.each([false,true])('supplements exactly once, preserves the weather evidence and gates the next round (new evidence: %s)',async(filled)=>{
    const taskId=filled?'ny-filled':'ny-missing';
    const planId=taskId+'-plan',nodeId=taskId+'-node';
    await mkdir(join(workspaceRoot,taskId),{recursive:true});
    await dataSource.query("INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path) VALUES ($1,'纽约天气','awaiting_review','platform_auto',$2)",[taskId,join(workspaceRoot,taskId)]);
    const compiled={version:'v1',nodes:[{id:'research',type:'agent_call',agentId:'web-research',agentVersion:'2.0.0',capability:'research.web',workspace:{mode:'isolated'},input:{query:'纽约天气'}},{id:'finish',type:'end',dependsOn:['research']}]};
    await dataSource.query("INSERT INTO task_plans(id,task_id,version,state,plan) VALUES ($3,$1,1,'compiled',$2::jsonb)",[taskId,JSON.stringify(compiled),planId]);
    const result={status:'succeeded',output:{summary:'纽约中央公园有小雨',gaps:['缺少实测温度']},evidence:[{source:'https://weather.gov/',excerpt:'light rain'}]};
    await dataSource.query("INSERT INTO task_nodes(id,plan_id,node_key,state,capability,output) VALUES ($2,$3,'research','completed','research.web',$1::jsonb)",[JSON.stringify(result),nodeId,planId]);
    await dataSource.query("INSERT INTO agents(id,display_name) VALUES ('web-research','公开研究') ON CONFLICT DO NOTHING");
    await dataSource.query("INSERT INTO agent_versions(id,agent_id,version,status,manifest) VALUES ('web-research@2','web-research','2.0.0','ready',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify({capabilities:[{name:'research.web'}],inputSchema:{properties:{requirements:{type:'array'}}}})]);
    const id=filled?'00000000-0000-4000-a000-000000000002':'00000000-0000-4000-a000-000000000001';
    const criteria=[{id:'R1',requirement:'实测温度',priority:'required',basis:'天气'}];
    const assessment={review:true,reportedGaps:['缺少实测温度'],items:[{id:'R1',status:'missing',reason:'缺少实测温度',evidenceIds:[]}],evidence:[{id:'E1',source:'https://weather.gov/',text:'light rain'}]};
    await dataSource.query('INSERT INTO task_acceptance_rounds(id,task_id,round,criteria,assessment) VALUES ($1,$2,1,$3::jsonb,$4::jsonb)',[id,taskId,JSON.stringify(criteria),JSON.stringify(assessment)]);
    const decide=(decision:string,reviewId:string)=>app.inject({method:'POST',url:'/v1/tasks/'+taskId+'/review',headers:{authorization:'Bearer '+token},payload:{decision,reviewId}});
    const responses=await Promise.all([decide('supplement',id),decide('supplement',id)]);
    expect(responses.map(r=>r.statusCode).sort()).toEqual([201,409]);
    const [node]=await dataSource.query("SELECT id,node_key,workspace_path FROM task_nodes WHERE plan_id=$1 AND node_key LIKE 'supplement-%'",[planId]);
    const env=JSON.parse(await readFile(join(node.workspace_path,'envelope.json'),'utf8'));
    expect(env.input.query).toBe('纽约天气');
    for(const v of ['缺少实测温度','纽约中央公园有小雨','https://weather.gov/','light rain']) expect(env.input.requirements.join(' ')).toContain(v);
    expect((await dataSource.query("SELECT output FROM task_nodes WHERE id=$1",[nodeId]))[0].output).toEqual(result);
    const terminal=filled ? {status:'succeeded',output:{summary:'中央公园气温 8.9°C',gaps:[]},evidence:[{source:'https://weather.gov/',excerpt:'Temperature 8.9°C'}]} : {status:'failed',output:{coverage:'insufficient',gaps:['缺少实测温度']},evidence:[]};
    const callback=await app.inject({method:'POST',url:'/internal/v1/instances/'+env.instanceId+'/result',payload:{leaseToken:env.leaseToken,result:{protocolVersion:'v1',taskId,taskNodeId:node.id,instanceId:env.instanceId,...terminal,artifacts:[],risks:[]}}});
    expect(callback.statusCode).toBe(201);
    const detail=(await app.inject({method:'GET',url:'/v1/tasks/'+taskId,headers:{authorization:'Bearer '+token}})).json();
    expect(detail.task.state).toBe(filled?'accepted':'awaiting_review');
    expect(detail.acceptanceRounds).toHaveLength(2);
    expect(detail.acceptanceRounds[1].criteria).toEqual(criteria);
    expect((await decide('accept',id)).statusCode).toBe(409);
    if(!filled) expect((await decide('accept',detail.acceptanceRounds[1].id)).statusCode).toBe(201);
    expect((await dataSource.query('SELECT state FROM tasks WHERE id=$1',[taskId]))[0].state).toBe('accepted');
    nodeManager.startInstance.mockClear();
  });

  it('accepts a human decision to retain the current delivery', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/tasks/task-review/review', headers: { authorization: `Bearer ${token}` }, payload: { decision: 'accept' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ state: 'accepted', decision: 'accept' });
  });

  it('restarts only the failed PPT and quality nodes with an immutable previous delivery and quality feedback', async () => {
    await dataSource.query(`UPDATE tasks SET state='awaiting_review' WHERE id='task-review'`);
    await dataSource.query(`UPDATE task_nodes SET state='completed', output=$1::jsonb WHERE id='node-ppt'`, [JSON.stringify(pptResult())]);
    await dataSource.query(`UPDATE task_nodes SET state='completed', output=$1::jsonb WHERE id='node-quality'`, [JSON.stringify(qualityResult())]);
    nodeManager.startInstance.mockClear();

    const response = await app.inject({ method: 'POST', url: '/v1/tasks/task-review/review', headers: { authorization: `Bearer ${token}` }, payload: { decision: 'rework' } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ state: 'running', decision: 'rework' });
    expect(nodeManager.startInstance).toHaveBeenCalledTimes(1);

    const nodes = await dataSource.query<Array<{ id: string; state: string; input: { referenceMaterials?: string[] } }>>(`SELECT id, state, input FROM task_nodes ORDER BY id`);
    expect(nodes.find((node) => node.id === 'node-retrieve')).toMatchObject({ state: 'completed' });
    expect(nodes.find((node) => node.id === 'node-ppt')).toMatchObject({ state: 'running' });
    expect(nodes.find((node) => node.id === 'node-quality')).toMatchObject({ state: 'pending' });
    const materials = nodes.find((node) => node.id === 'node-ppt')!.input.referenceMaterials ?? [];
    expect(materials).toEqual(expect.arrayContaining([
      expect.stringContaining('previous-presentation-2.pptx'),
      expect.stringContaining('previous-quality-assessment-2.json'),
      expect.stringContaining('previous-acceptance-criteria-2.json'),
      expect.stringContaining('retry-context-2.md'),
    ]));
    const pptWorkspace = join(workspaceRoot, 'task-review', 'nodes', 'create-presentation');
    const qualityWorkspace = join(workspaceRoot, 'task-review', 'nodes', 'quality-check');
    const retryContext = materials.find((path) => path.includes('retry-context-2.md'))!;
    await expect(readFile(join(pptWorkspace, retryContext), 'utf8')).resolves.toContain('缺少项目里程碑');
    await expect(readFile(join(pptWorkspace, materials.find((path) => path.includes('previous-presentation-2.pptx'))!), 'utf8')).resolves.toBe('first ppt');
    await expect(access(join(pptWorkspace, 'presentation.pptx'))).rejects.toThrow();
    await expect(access(join(pptWorkspace, 'ppt-qa.json'))).rejects.toThrow();
    await expect(access(join(pptWorkspace, '.mg-codex-last-message.txt'))).rejects.toThrow();
    await expect(access(join(qualityWorkspace, 'quality-assessment.json'))).rejects.toThrow();
    await expect(access(join(qualityWorkspace, 'acceptance-criteria.json'))).rejects.toThrow();
    expect(await dataSource.query(`SELECT id FROM task_artifacts WHERE task_id='task-review'`)).toHaveLength(3);
    expect(await dataSource.query(`SELECT kind FROM task_activity_events WHERE task_id='task-review' AND kind='human_rework_requested'`)).toHaveLength(1);
  });
});

async function seedFailedPresentation(): Promise<void> {
  const taskRoot = join(workspaceRoot, 'task-review');
  const retrieve = join(taskRoot, 'nodes', 'retrieve');
  const ppt = join(taskRoot, 'nodes', 'create-presentation');
  const quality = join(taskRoot, 'nodes', 'quality-check');
  const artifactRoot = join(taskRoot, 'artifacts', 'nodes');
  await Promise.all([mkdir(retrieve, { recursive: true }), mkdir(ppt, { recursive: true }), mkdir(quality, { recursive: true }), mkdir(artifactRoot, { recursive: true })]);
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-review','制作栖知产品介绍PPT','platform_auto','awaiting_review',$1)`, [taskRoot]);
  await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('plan-review','task-review',1,$1::jsonb,'compiled')`, [JSON.stringify(plan())]);
  await dataSource.query(`INSERT INTO task_nodes (id, plan_id, node_key, state, input, output, capability, agent_id, agent_version, depends_on, workspace_path) VALUES
    ('node-retrieve','plan-review','retrieve','completed','{}',$1::jsonb,'knowledge.retrieve','ragflow-knowledge','1.0.0','[]'::jsonb,$2),
    ('node-ppt','plan-review','create-presentation','completed','{}',$3::jsonb,'presentation.create','ppt-maker','1.0.1','["retrieve"]'::jsonb,$4),
    ('node-quality','plan-review','quality-check','completed','{}',$5::jsonb,'quality.define_and_verify','quality-management','1.0.1','["create-presentation"]'::jsonb,$6)`, [JSON.stringify({ status: 'succeeded', evidence: [{ source: 'ragflow', excerpt: '栖知项目背景' }], artifacts: [] }), retrieve, JSON.stringify(pptResult()), ppt, JSON.stringify(qualityResult()), quality]);
  await dataSource.query(`INSERT INTO task_attempts (id, task_node_id, instance_id, attempt_number, lease_token, lease_expires_at, state, result) VALUES
    ('attempt-ppt','node-ppt','instance-ppt',1,'task-review-ppt-lease-token-000000',now()+interval '5 minutes','completed',$1::jsonb),
    ('attempt-quality','node-quality','instance-quality',1,'task-review-quality-lease-token-000',now()+interval '5 minutes','completed',$2::jsonb)`, [JSON.stringify(pptResult()), JSON.stringify(qualityResult())]);
  await archive(taskRoot, 'node-ppt', 'attempt-ppt', 'presentation.pptx', 'first ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  await archive(taskRoot, 'node-quality', 'attempt-quality', 'quality-assessment.json', JSON.stringify({ passed: false, summary: '缺少项目里程碑' }), 'application/json');
  await archive(taskRoot, 'node-quality', 'attempt-quality', 'acceptance-criteria.json', JSON.stringify([{ id: 'C01', criterion: '包含项目里程碑' }]), 'application/json');
  await Promise.all([
    writeFile(join(ppt, 'presentation.pptx'), 'stale active ppt'),
    writeFile(join(ppt, 'ppt-qa.json'), JSON.stringify({ passed: false })),
    writeFile(join(ppt, '.mg-codex-last-message.txt'), 'stale Codex answer'),
    writeFile(join(quality, 'quality-assessment.json'), JSON.stringify({ passed: false, criteria: [], findings: [], summary: 'stale assessment' })),
    writeFile(join(quality, 'acceptance-criteria.json'), '[]'),
  ]);
}

async function archive(taskRoot: string, nodeId: string, attemptId: string, fileName: string, content: string, mediaType: string): Promise<void> {
  const storagePath = join('artifacts', 'nodes', nodeId, 'revision-1', fileName);
  const fullPath = join(taskRoot, storagePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content);
  await dataSource.query(`INSERT INTO task_artifacts (id, task_id, task_node_id, task_attempt_id, revision, original_path, storage_path, file_name, media_type, sha256, size_bytes) VALUES ($1,'task-review',$2,$3,1,$4,$5,$4,$6,$7,$8)`, [`artifact-${fileName}`, nodeId, attemptId, fileName, storagePath, mediaType, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)]);
}

function plan() {
  return { version: 'v1', nodes: [
    { id: 'retrieve', type: 'agent_call', capability: 'knowledge.retrieve', agentId: 'ragflow-knowledge', agentVersion: '1.0.0', input: { query: '栖知' }, workspace: { mode: 'isolated' } },
    { id: 'create-presentation', type: 'agent_call', capability: 'presentation.create', agentId: 'ppt-maker', agentVersion: '1.0.1', dependsOn: ['retrieve'], input: { brief: '制作栖知产品介绍', title: '栖知产品介绍', referenceMaterials: [] }, inputBindings: [{ target: 'referenceMaterials', fromNode: 'retrieve', source: 'evidence', format: 'evidence_markdown' }], workspace: { mode: 'isolated' } },
    { id: 'quality-check', type: 'agent_call', capability: 'quality.define_and_verify', agentId: 'quality-management', agentVersion: '1.0.1', dependsOn: ['create-presentation'], input: { requirements: '包含项目里程碑', targets: [] }, inputBindings: [{ target: 'targets', fromNode: 'create-presentation', source: 'artifact', artifactPath: 'presentation.pptx', format: 'artifact_paths' }], workspace: { mode: 'isolated' } },
    { id: 'finish', type: 'end', dependsOn: ['quality-check'] },
  ] };
}

function pptResult() { return { status: 'succeeded', output: { title: '栖知产品介绍' }, evidence: [], risks: [], artifacts: [{ path: 'presentation.pptx', sha256: createHash('sha256').update('first ppt').digest('hex') }] }; }
function qualityResult() { return { status: 'succeeded', output: { passed: false, summary: '缺少项目里程碑', findings: [{ severity: 'major', message: '缺少项目里程碑' }] }, evidence: [], risks: ['quality_acceptance_failed'], artifacts: [{ path: 'quality-assessment.json', sha256: createHash('sha256').update(JSON.stringify({ passed: false, summary: '缺少项目里程碑' })).digest('hex') }, { path: 'acceptance-criteria.json', sha256: createHash('sha256').update(JSON.stringify([{ id: 'C01', criterion: '包含项目里程碑' }])).digest('hex') }] }; }
