// Replay a single real reviewed delivery in the isolated test DB through HTTP
// and the installed node manager. The referenced original is read-only.
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppModule } from '../../apps/control-plane/src/app.module';
import { loadControlPlaneEnv } from '../../apps/control-plane/src/config/env';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { HttpNodeManagerClient } from '../../apps/control-plane/src/registry/node-manager.http-client';

async function main(){
  const env=loadControlPlaneEnv(process.env);
  const dbUrl=process.env.TEST_DATABASE_URL;
  if(!dbUrl || new URL(dbUrl).pathname!=='/middleground_test' || dbUrl===env.databaseUrl) throw new Error('Isolated DB required.');
  const original=process.argv[2];
  const src=createControlPlaneDataSource(env.databaseUrl), db=createControlPlaneDataSource(dbUrl);
  await src.initialize(); await db.initialize();
  const host='http://127.0.0.1:39019';
  const token=randomUUID();
  const root=await mkdtemp('/home/middleground/data/workspaces/acceptance-smoke-');
  const app=await NestFactory.create(AppModule.register({dataSource:db, adminTokenHash:createHash('sha256').update(token).digest('hex'),
    nodeManager:new HttpNodeManagerClient(env.nodeManagerUrl,env.nodeManagerInternalToken),taskRuntime:{workspaceRoot:root,
    callbackBaseUrl:host, instanceRuntimeRoot:join(root,'runtime'),ragflowBaseUrl:'http://invalid',ragflowApiKey:'',datasetIds:[]}}),new FastifyAdapter(),{logger:false});
  try {
    await app.listen(39019,'127.0.0.1');
    const [t]=await src.query('SELECT goal,workspace_path FROM tasks WHERE id=$1',[original]);
    const [r]=await src.query('SELECT criteria,assessment FROM task_acceptance_rounds WHERE task_id=$1 ORDER BY round LIMIT 1',[original]);
    const [n]=await src.query("SELECT n.* FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 AND n.capability='research.web' ORDER BY n.created_at LIMIT 1",[original]);
    const [p]=await src.query('SELECT plan FROM task_plans WHERE id=$1',[n.plan_id]);
    const [a]=await src.query("SELECT * FROM agent_versions WHERE agent_id=$1 AND version=$2 AND status='ready'",[n.agent_id,n.agent_version]);
    const snapshot=JSON.parse(await readFile(join(t.workspace_path,'task.json'),'utf8'));
    await db.query('INSERT INTO agents(id,display_name) VALUES ($1,$1) ON CONFLICT DO NOTHING',[a.agent_id]);
    await db.query("INSERT INTO agent_versions(id,agent_id,version,status,manifest,approved_at) VALUES ($1,$2,$3,'ready',$4::jsonb,now()) ON CONFLICT(agent_id,version) DO UPDATE SET manifest=excluded.manifest,approved_at=now(),status='ready'",[a.id,a.agent_id,a.version,JSON.stringify(a.manifest)]);
    for(const decision of ['accept','supplement']){
      const id=randomUUID(), rid=randomUUID(), planId=randomUUID(), workspace=join(root,id);
      await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'task.json'),JSON.stringify({...snapshot,id}));
      await db.transaction(async m=>{
        await m.query("INSERT INTO tasks(id,goal,state,acceptance_mode,workspace_path,created_at) VALUES($1,$2,'awaiting_review','platform_auto',$3,$4)",[id,t.goal,workspace,snapshot.createdAt]);
        await m.query("INSERT INTO task_plans(id,task_id,version,plan,state) VALUES ($1,$2,1,$3::jsonb,'compiled')",[planId,id,JSON.stringify(p.plan)]);
        await m.query("INSERT INTO task_nodes(id,plan_id,node_key,state,input,output,capability,agent_id,agent_version,depends_on) VALUES ($1,$2,$3,'completed',$4::jsonb,$5::jsonb,$6,$7,$8,'[]')",[randomUUID(),planId,n.node_key,JSON.stringify(n.input),JSON.stringify(n.output),n.capability,n.agent_id,n.agent_version]);
        await m.query("INSERT INTO task_acceptance_rounds(id,task_id,round,criteria,assessment) VALUES($1,$2,1,$3::jsonb,$4::jsonb)",[rid,id,JSON.stringify(r.criteria),JSON.stringify(r.assessment)]);
      });
      const response=await fetch(host+'/v1/tasks/'+id+'/review',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({decision,reviewId:rid})});
      if(!response.ok) throw new Error('Review HTTP '+response.status+' '+await response.text());
      console.log(id,decision,await response.text());
      if(decision==='supplement'){
        let state='running';
        while(state==='running'||state==='planned'){
          await new Promise(resolve=>setTimeout(resolve,4000));
          state=(await db.query('SELECT state FROM tasks WHERE id=$1',[id]))[0].state;
        }
        const rounds=await db.query("SELECT round,decision,assessment->>'error' AS error FROM task_acceptance_rounds WHERE task_id=$1 ORDER BY round",[id]);
        const nodes=await db.query("SELECT node_key,state FROM task_nodes WHERE plan_id=$1 ORDER BY created_at",[planId]);
        console.log(JSON.stringify({state,rounds,nodes}));
        if(!['awaiting_review','accepted'].includes(state)||rounds.length!==2||rounds[1].error||nodes[1]?.state!=='completed') throw new Error('Live supplement did not complete as expected');
      }
    }
  } finally {await app.close();await src.destroy();await db.destroy();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
