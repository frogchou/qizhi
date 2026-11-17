import { describe, expect, it } from 'vitest';
import { buildTaskDelivery, nodeAnswer, selectDeliveryNodes } from '../../apps/control-plane/src/tasks/delivery-content';
import { deliveryMaterial } from '../../apps/control-plane/src/tasks/delivery-acceptance';

const quality = {
  id: 'qc', plan_id: 'p1', node_key: 'review_documents', capability: 'quality.define_and_verify', state: 'completed',
  output: { status: 'succeeded', output: { summary: '两份 README 已审阅，passed=true。', passed: true,
    findings: [
      { path: 'input/first-README.md', severity: 'info', message: '第一份说明智能工厂的使用方式和八个区域的职责。' },
      { path: 'input/second-README.md', severity: 'info', message: '第二份说明中台调度、任务恢复和资料传递机制。' },
    ] }, artifacts: [{ path: 'quality-assessment.json', sha256: 'a'.repeat(64) }] },
};
const plan = { id: 'p1', version: 1 };
const task = { current_plan_version: 1, revision_number: 0 };
const file = { id: 'qa', taskNodeId: 'qc', originalPath: 'quality-assessment.json', revision: 1, sha256: 'a'.repeat(64) };

describe('交付正文', () => {
  it('exposes both legacy README analyses rather than their execution acknowledgement', () => {
    const delivery = buildTaskDelivery({ task, plans: [plan], nodes: [quality], artifacts: [file] });
    expect(delivery.answers).toHaveLength(1);
    expect(delivery.answers[0].body).toContain('第一份说明智能工厂');
    expect(delivery.answers[0].body).toContain('第二份说明中台调度');
    expect(delivery.answers[0].body).not.toContain('已审阅');
    expect(delivery.artifactIds).toEqual([]);
    expect(delivery.supportingArtifactIds).toEqual(['qa']);
  });
  it('retains the full answer for display and acceptance and does not select an empty field', () => {
    const body = '## 文件分析\n' + '这里是真正的文件内容与用途说明。'.repeat(900) + '\n最后的结论。';
    const output = { status: 'succeeded', output: { text: '', answer: body, summary: '报告已生成' } };
    expect(nodeAnswer({ nodeKey: 'analyze', capability: 'document.analyze', output })).toBe(body);
    expect(deliveryMaterial([{ nodeKey: 'analyze', capability: 'document.analyze', output }]).deliveries[0].answer).toBe(body);
  });
  it('presents production results with their JSON deliverable, preserving quality records as supporting files', () => {
    const producer = { id: 'a', plan_id: 'p1', node_key: 'analyze', state: 'completed', capability: 'document.analyze',
      output: { status: 'succeeded', output: { answer: '两份文件的完整分析' }, artifacts: [{ path: 'data.json', sha256: 'b'.repeat(64) }] } };
    const nodes = [producer, { ...quality, depends_on: ['analyze'] }];
    const delivery = buildTaskDelivery({ task, plans: [plan], nodes, artifacts: [file,
      { id: 'data', taskNodeId: 'a', originalPath: 'data.json', revision: 1, sha256: 'b'.repeat(64) }] });
    expect(delivery.answers.map(x => x.body)).toEqual(['两份文件的完整分析']);
    expect(delivery.artifactIds).toEqual(['data']);
    expect(delivery.supportingArtifactIds).toEqual(['qa']);
  });
  it('hides all previous results while an amended task is awaiting its new plan', () => {
    const delivery = buildTaskDelivery({ task: { ...task, revision_number: 1, state: 'planning', planner_summary: { mode: 'direct_answer', summary: 'old' } },
      plans: [plan], nodes: [quality], artifacts: [file], revisions: [{ revisionNumber: 1, planVersion: null }] });
    expect(delivery).toEqual({ revisionNumber: 1, answers: [], artifactIds: [], supportingArtifactIds: [] });
  });
  it('does not merge prior plans, old attempts, or failed node text into the current result', () => {
    const output = { status: 'succeeded', output: { answer: '新分析' }, artifacts: [{ path: 'report.md', sha256: 'c'.repeat(64) }] };
    const nodes = [quality, { id: 'new', plan_id: 'p2', node_key: 'analyze', state: 'completed', output },
      { id: 'failed', plan_id: 'p2', node_key: 'broken', state: 'failed', output: { status: 'failed', output: { answer: '失败过程中的内容' } } }];
    const delivery = buildTaskDelivery({ task: { current_plan_version: 2, revision_number: 1 }, plans: [plan, { id: 'p2', version: 2 }], nodes,
      revisions: [{ revisionNumber: 1, planVersion: 2 }], artifacts: [file,
        { id: 'old', taskNodeId: 'new', originalPath: 'report.md', revision: 1, sha256: 'b'.repeat(64) },
        { id: 'new', taskNodeId: 'new', originalPath: 'report.md', revision: 2, sha256: 'c'.repeat(64) }] });
    expect(delivery.answers.map(x => x.body)).toEqual(['新分析']);
    expect(delivery.artifactIds).toEqual(['new']);
    expect(delivery.supportingArtifactIds).toEqual([]);
  });
  it('keeps parallel final answers but uses downstream work instead of consumed retrieval notes', () => {
    const nodes = [
      { nodeKey: 'retrieve', capability: 'knowledge.retrieve', output: { output: { summary: '检索片段' } } },
      { nodeKey: 'write', capability: 'document.analyze', dependsOn: ['retrieve'], output: { output: { answer: '完整分析' } } },
      { nodeKey: 'other', capability: 'custom.output', output: { output: { text: '独立的第二项结果' } } },
    ];
    expect(selectDeliveryNodes(nodes).map(n => n.nodeKey)).toEqual(['write', 'other']);
  });
  it('does not let retrieval notes hide a legacy review node containing the actual analysis', () => {
    const nodes = [
      { nodeKey: 'retrieve', capability: 'knowledge.retrieve', output: { output: { summary: '检索片段' } } },
      { nodeKey: 'review', capability: quality.capability, output: quality.output, dependsOn: ['retrieve'] },
    ];
    expect(selectDeliveryNodes(nodes).map(n => n.nodeKey)).toEqual(['review']);
    expect(deliveryMaterial(nodes).deliveries[0].answer).toContain('第二份说明中台调度');
  });
});
