import { describe,expect,it,vi } from 'vitest';
import { assessDelivery, deliveryMaterial, type Criterion } from '../../apps/control-plane/src/tasks/delivery-acceptance';
import type { CodexRunner } from '../../packages/codex-runtime/src';

const criteria:Criterion[]=[{id:'R1',requirement:'纽约实测气温',basis:'气温',priority:'required'}];
const nodes=[{nodeKey:'research',capability:'research.web',output:{output:{coverage:'complete',summary:'中央公园小雨'},evidence:[{source:'https://weather.gov/',excerpt:'light rain'}]}}];
describe('原始需求验收',()=>{
  it('assesses the complete document explanation instead of a short completion summary', () => {
    const answer = '第一份说明智能工厂的使用方式。'.repeat(400) + '第二份说明任务中台的实现机制。';
    const content = deliveryMaterial([{ nodeKey:'analysis', capability:'document.analyze', output:{status:'succeeded', output:{summary:'两份文件已处理',answer}} }]);
    expect(content.deliveries[0].answer).toBe(answer);
  });
  it('reports acceptance runtime progress and preserves operator cancellation', async () => {
    const controller = new AbortController();
    const progress = vi.fn(async () => { controller.abort(); });
    const runner: CodexRunner = {
      async run(input) {
        await input.onStatus?.({ state:'running', elapsedMs:10_000, outputReceived:false });
        input.signal?.throwIfAborted();
        throw new Error('The operator signal did not reach the evaluator.');
      },
    };
    await expect(assessDelivery(runner,'/unused','纽约气温','2026-11-13T01:30:00Z',nodes,criteria,controller.signal,progress))
      .rejects.toMatchObject({name:'AbortError'});
    expect(progress).toHaveBeenCalledWith('assessment',{state:'running',elapsedMs:10_000,outputReceived:false});
  });
  it.each([
    ['missing',[],true],['met',['invented'],true],['met',[],true],['met',['E1'],false],
  ] as const)('checks the status %s against actual evidence %j',async(status,evidenceIds,review)=>{
    const run=vi.fn(async()=>({lastMessage:JSON.stringify({items:[{id:'R1',status,reason:'检查结果',evidenceIds}]})}));
    const result=await assessDelivery({run},'/unused','纽约气温','2026-11-13T01:30:00Z',nodes,criteria);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.assessment.review).toBe(review);
  });
  it('fails closed when a proposed criterion invents wording not present in the original goal',async()=>{
    const result=await assessDelivery({run:async()=>({lastMessage:JSON.stringify({items:[{requirement:'必须给出全天最低温',basis:'最低温',priority:'required'}]})})},'/unused','纽约天气','2026-11-13T01:30:00Z',nodes,[]);
    expect(result.assessment.review).toBe(true);
    expect(result.assessment).toHaveProperty('error');
  });
});
