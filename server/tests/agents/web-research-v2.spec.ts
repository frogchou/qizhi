import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskEnvelope } from '../../packages/agent-protocol/src/index';
import type { CodexRunInput } from '../../packages/codex-runtime/src/index';
import { runTask } from '../../agents/web-research-v2/src/run-task';
import { readablePage, type Candidate } from '../../agents/web-research-v2/src/source-reader';
import { presentTask } from '../../apps/console/src/lib/task-presenter';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{force:true,recursive:true}); });
const quote = 'Observed at station X: light rain.';
const makeCandidate = (host:string) => ({title:host,url:'https://'+host+'/',format:'json'});
async function exercise(mode: 'fallback'|'empty'|'badQuote') {
  const root = await mkdtemp(join(tmpdir(),'research-'));
  roots.push(root);
  const referenceTime = '2026-11-13T00:59:59.000Z';
  await writeFile(join(root,'task.json'),JSON.stringify({createdAt:referenceTime,goal:'纽约今天的天气？'}));
  const workspacePath = join(root,'node');
  await mkdir(workspacePath);
  const env:TaskEnvelope={protocolVersion:'v1',taskId:'t',taskNodeId:'n',instanceId:'i',attemptNumber:1,leaseToken:'lease',taskRoot:root,workspacePath,callback:{url:'http://localhost'},input:{query:'纽约今天的天气？'}};
  const events:AgentEvent[]=[];
  let round=0;
  const run = vi.fn(async(input:CodexRunInput)=>{
    expect(input.prompt).toContain(referenceTime);
    if(input.researchMode==='discovery') {
      round++;
      return {lastMessage:JSON.stringify({candidates:[makeCandidate(round===1?'bad.example':'station.example')]})};
    }
    expect(input.researchMode).toBe('synthesis');
    return {lastMessage:JSON.stringify({claims:[{statement:'观测为小雨',sourceId:'S1',quote:mode==='badQuote'?'Unsupported statement from nowhere':quote}],gaps:[]})};
  });
  const read=async(c:Candidate)=>{
    const invalid=c.url.includes('bad.example')||mode==='empty';
    const text=readablePage(invalid?'<!DOCTYPE html><html>redirect</html>':JSON.stringify({description:quote}),invalid?'text/html':'application/json',c.format);
    return {url:c.url,text,retrievedAt:referenceTime};
  };
  const result=await runTask(env,{report:async e=>{events.push(e)}},{run},read);
  const ledger=JSON.parse(await readFile(join(workspacePath,'sources.json'),'utf8'));
  return {result,ledger,events,round};
}
describe('Codex evidence research',()=>{
  it('rejects a successful HTML response to a JSON request, searches again, and delivers a cited answer',async()=>{
    const {result,ledger,events,round}=await exercise('fallback');
    expect(result.status).toBe('succeeded');
    expect(round).toBe(2);
    expect(ledger.rejected[0].reason).toContain('HTML');
    expect(result.output.summary).toContain('[S1]');
    expect(ledger.claims[0].quote).toBe(quote);
    expect(events.some(e=>String(e.payload.stage).includes('补查'))).toBe(true);
    const ui=presentTask({nodes:[{id:'n',capability:'research.web',agent_version:'2.0.0',output:result}]});
    expect(ui.nodes[0].research?.sources[0].url).toBe('https://station.example/');
    expect(ui.nodes[0].runtime).toContain('Codex');
  });
  it.each(['empty','badQuote'] as const)('fails with an inspectable evidence ledger for %s',async mode=>{
    const {result,ledger}=await exercise(mode);
    expect(result.status).toBe('failed');
    expect(result.evidence).toEqual([]);
    expect(result.output.coverage).toBe('insufficient');
    expect(ledger.gaps.length).toBeGreaterThan(0);
    expect(result.artifacts.map(a=>a.path)).toContain('sources.json');
  });
});
