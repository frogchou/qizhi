import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexCliRunner } from '../../packages/codex-runtime/src/index.js';
import { runTask } from '../../agents/web-research-v2/src/run-task.js';

async function main() {
  const root = await mkdtemp('/home/middleground/data/workspaces/smoke-research-');
  const node = join(root,'nodes','research');
  await mkdir(node,{recursive:true});
  const goal = '今天的纽约市的天气情况是什么？';
  await writeFile(join(root,'task.json'),JSON.stringify({goal,createdAt:new Date().toISOString()}));
  console.log('workspace='+root);
  const result = await runTask({protocolVersion:'v1',taskId:randomUUID(),taskNodeId:'research',workspacePath:node,
    taskRoot:root,nodeWorkspacePath:node,attemptNumber:1, instanceId:randomUUID(),leaseToken:randomUUID(),
    callback:{url:'http://127.0.0.1'},input:{query:goal,requirements:['注明纽约当地日期，分开描述实况与预报，摄氏温度'],language:'zh-CN'}},
    {report:async e=>{console.log(JSON.stringify({type:e.type,stage:e.payload.stage,elapsedMs:e.payload.elapsedMs,coverage:e.payload.coverage}));}},new CodexCliRunner());
  console.log(JSON.stringify({status:result.status,summary:result.output.summary,sources:result.evidence.map(e=>e.source)}));
  if(result.status==='failed') process.exitCode=1;
}
main().catch(()=>{console.error('Smoke failed; inspect the scoped run logs.');process.exitCode=1});
