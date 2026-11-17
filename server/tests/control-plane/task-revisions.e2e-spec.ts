import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { CodexPlannerService, type PlannerOutput } from '../../apps/control-plane/src/planning/codex-planner.service';
import { TaskInputService } from '../../apps/control-plane/src/tasks/task-input.service';
import { TaskArtifactService } from '../../apps/control-plane/src/tasks/task-artifact.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { TaskRecoveryService } from '../../apps/control-plane/src/tasks/task-recovery.service';
import { requiredTestDatabaseUrl } from './test-database';

const db=createControlPlaneDataSource(requiredTestDatabaseUrl());
const headers={authorization:'Bearer test-revision'};
const nodeManager={requestSelfCheck:vi.fn(),syncReadyVersion:vi.fn(),stopInstance:vi.fn(),
  startInstance:vi.fn(async (job:{instanceId:string;envelopePath:string})=>({instanceId:job.instanceId,unitName:'mg-agent-'+job.instanceId}))};
const assess=vi.fn(async (input:{outputSchemaPath?:string;prompt:string})=>({lastMessage:JSON.stringify({items:
  input.outputSchemaPath?.includes('criteria') ? [{basis:'制作',requirement:'制作修订版',priority:'required'}]:
    [{id:'R1',status:'met',reason:'本轮已新增材料',evidenceIds:['E1']}]})}));
let app:NestFastifyApplication, root:string;
const latestReview='00000000-0000-4000-8000-000000000111';
const post=(taskId:string,body:object,key?:string)=>app.inject({method:'POST',url:'/v1/tasks/'+taskId+'/review',headers:{...headers,...(key?{'idempotency-key':key}:{})},payload:body});
const detail=async(id:string)=>(await app.inject({method:'GET',url:'/v1/tasks/'+id,headers})).json();
async function seed(id:string) {
  const workspace=await app.get(TaskWorkspaceService).create({id,goal:'制作报告',acceptanceMode:'platform_auto'});
  await db.query("INSERT INTO tasks(id,goal,acceptance_mode,state,workspace_path,current_plan_version) VALUES ($1,'制作报告','platform_auto','awaiting_review',$2,1)",[id,workspace.root]);
  await db.query("INSERT INTO task_plans(id,task_id,version,state,plan) VALUES ($1,$2,1,'compiled',$3::jsonb)",[id+'-v1',id,JSON.stringify({nodes:[{id:'work',type:'agent_call',agentId:'maker',agentVersion:'1.0.0'},{id:'finish',type:'end'}]})]);
  return workspace;
}

describe('human revisions within a single task',()=>{
  beforeAll(async()=>{
    root=await mkdtemp(join(tmpdir(),'mg-revisions-'));
    await db.initialize(); await db.dropDatabase(); await db.runMigrations();
    app=await NestFactory.create(AppModule.register({dataSource:db,adminTokenHash:createHash('sha256').update('test-revision').digest('hex'),nodeManager,
      acceptanceRunner:{run:assess},taskRuntime:{ragflowApiKey:'',ragflowBaseUrl:'',datasetIds:[],workspaceRoot:root}}),new FastifyAdapter(),{logger:false});
    await app.init();
    await db.query("INSERT INTO agents(id,display_name) VALUES ('maker','制作')");
    const manifest={capabilities:[{name:'report.make'}],runtime:'native',inputSchema:{type:'object',properties:{files:{type:'array',items:{type:'string'}}},required:['files']},resultSchema:{type:'object',properties:{answer:{type:'string'}}}};
    await db.query("INSERT INTO agent_versions(id,agent_id,version,status,manifest) VALUES ('maker@1.0.0','maker','1.0.0','ready',$1::jsonb)",[JSON.stringify(manifest)]);
    vi.spyOn(app.get(CodexPlannerService),'plan').mockImplementation(async ({task})=>{
      const node={id:'work',type:'agent_call',capability:'report.make',workspace:{mode:'isolated'},input:{files:[]},
        taskInputBindings:task.inputs?.map(i=>({target:'files',format:'task_input_paths',inputId:i.id}))??[]};
      return {plan:{version:'v1',nodes:[node,{id:'finish',type:'end',dependsOn:['work']}]},intent:'制作',summary:'修订版',deliverables:['报告'],assumptions:[],risks:[],nodeReasons:{work:'使用本轮资料'}} as PlannerOutput;
    });
  });
  afterAll(async()=>{await app?.close(); if(db.isInitialized) await db.destroy(); await rm(root,{recursive:true,force:true});});

  it('freezes uploads once, replans with feedback, keeps the previous node and reopens a distinct assessment',async()=>{
    const taskId='repeat'; const workspace=await seed(taskId);
    const oldNode=await app.get(TaskWorkspaceService).createNodeWorkspace(taskId,'work');
    await writeFile(join(oldNode,'old.txt'),'previous delivery');
    await db.query(`INSERT INTO task_nodes(id,plan_id,node_key,state,workspace_path,output) VALUES ('prior','repeat-v1','work','completed',$1,'{"status":"succeeded","output":{"text":"上一版"}}')`,[oldNode]);
    await db.query("INSERT INTO task_attempts(id,task_node_id,instance_id,attempt_number,lease_token,lease_expires_at,state) VALUES ('prior-attempt','prior','done',1,'old',now(),'completed')");
    await writeFile(join(oldNode,'report.md'),'上一版档案中的唯一序号 B-1918');
    const [priorFile]=await app.get(TaskArtifactService).archiveVerifiedArtifacts({taskId,taskNodeId:'prior',taskAttemptId:'prior-attempt',nodeWorkspace:oldNode,
      artifacts:[{path:'report.md',sha256:createHash('sha256').update('上一版档案中的唯一序号 B-1918').digest('hex')}]});
    await db.query("INSERT INTO task_acceptance_rounds(id,task_id,round,criteria,assessment) VALUES ($1,$2,1,'[]','{\"review\":true}')",[latestReview,taskId]);
    const upload=await app.get(TaskInputService).stageUpload({originalFilename:'图表.txt',stream:Readable.from('补充样本')});
    const body={decision:'amend',message:'加入蓝色图表',inputIds:[upload.id],reviewId:latestReview};
    const outcomes=await Promise.all([post(taskId,body,'retry-A'),post(taskId,body,'retry-A')]);
    expect(outcomes.map(r=>r.statusCode)).toEqual([201,201]);
    expect(outcomes[1].json()).toEqual(outcomes[0].json());
    expect((await post(taskId,{...body,message:'different'},'retry-A')).json().code).toBe('idempotency_conflict');
    await vi.waitFor(()=>expect(nodeManager.startInstance.mock.calls.length).toBe(1));
    const env=JSON.parse(await readFile(nodeManager.startInstance.mock.calls[0][0].envelopePath,'utf8'));
    expect(env.nodeWorkspacePath).toBe(join(workspace.root,'revisions','1','nodes','work'));
    const contents=await Promise.all(env.input.files.map((file:string)=>readFile(join(env.nodeWorkspacePath,file),'utf8')));
    expect(contents.sort()).toEqual(['上一版档案中的唯一序号 B-1918','补充样本'].sort());
    expect(env.taskInputs.some((i:{sourceType:string})=>i.sourceType==='agent_artifact')).toBe(true);
    expect(await readFile(join(oldNode,'old.txt'),'utf8')).toBe('previous delivery');
    const received=vi.mocked(app.get(CodexPlannerService).plan).mock.calls.at(-1)![0].task;
    expect(received.goal).toContain('加入蓝色图表');
    expect(JSON.stringify(received.reviewContext)).toContain('上一版');
    const result=await app.inject({method:'POST',url:'/internal/v1/instances/'+env.instanceId+'/result',payload:{
      leaseToken:env.leaseToken,result:{protocolVersion:'v1',taskId,taskNodeId:env.taskNodeId,instanceId:env.instanceId,status:'succeeded',
      output:{text:'包含蓝色图表的修订版'},evidence:[{source:'submitted-report',excerpt:'包含蓝色图表'}],artifacts:[],risks:[]}}});
    expect(result.statusCode,result.body).toBe(201);
    const item=await detail(taskId);
    expect(item.task.state).toBe('awaiting_review');
    expect(item.currentReviewId).not.toBe(latestReview);
    expect(item.acceptanceRounds.map((r:{round:number;decision:string|null})=>[r.round,r.decision])).toEqual([[1,'amend'],[2,null]]);
    expect(item.revisions[0]).toMatchObject({revisionNumber:1,planVersion:2,inputIds:outcomes[0].json().inputIds});
    expect(item.nodes).toHaveLength(2);
    expect(assess.mock.calls.some(([input])=>input.prompt.includes('加入蓝色图表'))).toBe(true);
    expect(assess.mock.calls.some(([input])=>input.prompt.includes('包含蓝色图表的修订版'))).toBe(true);
    expect((await app.get(TaskArtifactService).openForDownload(taskId,priorFile.id)).content.toString()).toContain('B-1918');
    expect((await post(taskId,{decision:'revise',reviewId:latestReview},'stale')).statusCode).toBe(409);
    expect((await post(taskId,{decision:'revise',reviewId:item.currentReviewId},'next-round')).json()).toMatchObject({taskId,revisionNumber:2});
    await vi.waitFor(()=>expect(nodeManager.startInstance.mock.calls.length).toBe(2));
    const stopped=await app.inject({method:'POST',url:'/v1/tasks/'+taskId+'/stop',headers});
    expect(stopped.statusCode).toBe(200);
    expect((await detail(taskId)).task.state).toBe('cancelled');
  });

  it('keeps a rejected upload reusable and resumes a committed legacy revision after restart',async()=>{
    const id='legacy'; await seed(id);
    expect((await post(id,{decision:'amend'},'empty')).json().code).toBe('invalid_revision');
    expect((await post(id,{decision:'revise'})).json().code).toBe('invalid_revision');
    const upload=await app.get(TaskInputService).stageUpload({originalFilename:'表.txt',stream:Readable.from('内容')});
    expect((await post(id,{decision:'amend',inputIds:[upload.id],reviewId:latestReview},'mismatch')).statusCode).toBe(409);
    const orchestration=app.get((await import('../../apps/control-plane/src/tasks/task-orchestration.service.js')).TaskOrchestrationService);
    const omit=vi.spyOn(orchestration,'enqueueRevision').mockImplementationOnce(()=>{});
    expect((await post(id,{decision:'amend',inputIds:[upload.id]},'restart')).json()).toMatchObject({state:'planning',revisionNumber:1,reviewId:null});
    omit.mockRestore();
    await app.get(TaskRecoveryService).recoverInterrupted();
    await vi.waitFor(async()=>expect((await detail(id)).task.state).toBe('running'));
    expect((await detail(id)).inputs).toHaveLength(1);
    await app.inject({method:'POST',url:'/v1/tasks/'+id+'/stop',headers});
  });
});
