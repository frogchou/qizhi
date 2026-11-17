import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExecutionPanel } from '../../apps/console/src/App';
import { presentTask } from '../../apps/console/src/lib/task-presenter';

const analysisBody = '## 两份文件的完整分析\n\n**第一份文件**明确了验收范围。\n\n| 文件 | 结论 |\n| --- | --- |\n| 第二份文件 | 时间节点需要补充 |\n\n- 建议保留双方确认记录。\n\n最后一段：附件二第十页的费用约定与附件一不一致，需要逐项确认。';
const qualityNode = {
  id: 'quality-current', plan_id: 'plan-current', node_key: 'compare-documents',
  display_title: '两份文件分析', capability: 'quality.define_and_verify', agent_id: 'quality-management', state: 'completed',
  output: { status: 'succeeded', output: {
    passed: false, summary: '已完成两份文件分析。',
    criteria: [{ id: 'scope', criterion: '逐项核对两份文件的约定', method: '对照原文条款', required: true }],
    findings: [{ severity: 'warning', path: '附件二.md', message: analysisBody }],
  } },
};
const artifacts = [
  { id: 'process-assessment', taskNodeId: qualityNode.id, fileName: 'quality-assessment.json', originalPath: 'quality-assessment.json', mediaType: 'application/json', revision: 1, sizeBytes: 1200 },
  { id: 'process-criteria', taskNodeId: qualityNode.id, fileName: 'acceptance-criteria.json', originalPath: 'acceptance-criteria.json', mediaType: 'application/json', revision: 1, sizeBytes: 300 },
  { id: 'requested-json', taskNodeId: 'producer-current', fileName: 'results.json', originalPath: 'results.json', mediaType: 'application/json', revision: 1, sizeBytes: 512 },
];
const detail = {
  task: { id: 'delivery-task', goal: '分析两份文件', state: 'awaiting_review', revision_number: 1, current_plan_version: 1 },
  planSummary: { summary: '检查两份文件并说明差异。' },
  plans: [{ id: 'plan-current', version: 1, plan: { nodes: [] } }],
  nodes: [qualityNode],
  artifacts: artifacts.slice(0, 2),
  attempts: [], events: [], activities: [], workflow: [],
};
const mixedDetail = { ...detail, artifacts, nodes: [...detail.nodes, { id: 'producer-current', plan_id: 'plan-current', node_key: 'export-results', capability: 'data.export', state: 'completed', output: {} }] };

function render(value: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(ExecutionPanel, { detail: value as any, onApprove: () => undefined }));
}

describe('console task delivery', () => {
  it('renders the complete authoritative answer as readable Markdown before files and quality', () => {
    const markup = render({ ...mixedDetail, delivery: {
      revisionNumber: 1,
      answers: [{ nodeKey: qualityNode.node_key, title: '两份文件分析', body: analysisBody, format: 'markdown' }],
      artifactIds: ['requested-json'], supportingArtifactIds: ['process-assessment', 'process-criteria'],
    } });
    const delivery = markup.slice(markup.indexOf('class="delivery-section"'), markup.indexOf('class="flow-section"'));
    expect(delivery).toContain('最后一段：附件二第十页的费用约定与附件一不一致，需要逐项确认。');
    expect(delivery).toContain('<strong>第一份文件</strong>');
    expect(delivery).toContain('<table>');
    expect(delivery).toContain('<li>建议保留双方确认记录。</li>');
    expect(markup.indexOf('最后一段：')).toBeLessThan(markup.indexOf('<h4>交付产物</h4>'));
    expect(markup.indexOf('最后一段：')).toBeLessThan(markup.indexOf('<h4>质量验收</h4>'));
  });

  it('keeps an explicitly empty delivery empty after a new revision', () => {
    const current = { ...mixedDetail, task: { ...detail.task, revision_number: 2, state: 'planning' }, delivery: {
      revisionNumber: 2, answers: [], artifactIds: [], supportingArtifactIds: [],
    } };
    const presentation = presentTask(current);
    expect(presentation.answers).toEqual([]);
    expect(presentation.artifacts).toEqual([]);
    expect(presentation.supportingArtifacts).toEqual([]);
    const markup = render(current);
    expect(markup).not.toContain('class="delivery-answer"');
    expect(markup).not.toContain('<strong>results.json</strong>');
  });

  it('uses full legacy answer or text before summary without truncating either', () => {
    const presentation = presentTask({ ...detail, nodes: [{ ...qualityNode, output: { output: {
      answer: analysisBody, text: '备用正文', summary: '简短摘要', findings: [{ message: '旧结构化内容' }],
    } } }] });
    expect(presentation.answers).toEqual([{ nodeKey: qualityNode.node_key, title: '两份文件分析', body: analysisBody, format: 'markdown' }]);
    const textOnly = presentTask({ ...detail, nodes: [{ ...qualityNode, output: { output: { text: analysisBody, summary: '简短摘要' } } }] });
    expect(textOnly.answers[0]?.body).toBe(analysisBody);
  });

  it('turns legacy findings and criteria into complete readable analysis instead of summary or JSON', () => {
    const presentation = presentTask(detail);
    expect(presentation.answers[0]?.body).toContain(analysisBody);
    expect(presentation.answers[0]?.body).toContain('逐项核对两份文件的约定');
    expect(presentation.answers[0]?.body).toContain('对照原文条款');
    expect(presentation.answers[0]?.body).toContain('附件二.md');
    expect(presentation.answers[0]?.body).not.toContain('"message":');
    const markup = render(detail);
    expect(markup.slice(0, markup.indexOf('class="debug-panel"'))).toContain('<strong>第一份文件</strong>');
  });

  it('limits legacy delivery to the current plan and stays empty while that revision awaits its plan', () => {
    const revised = { ...detail,
      task: { ...detail.task, revision_number: 2, current_plan_version: 2 },
      revisions: [{ revisionNumber: 2, planVersion: 2 }],
      plans: [{ id: 'plan-old', version: 1 }, { id: 'plan-current', version: 2 }],
      nodes: [{ ...qualityNode, id: 'old-node', plan_id: 'plan-old', output: { output: { answer: '上轮旧答复' } } }, qualityNode],
    };
    expect(presentTask(revised).answers.map(answer => answer.body).join('\n')).not.toContain('上轮旧答复');
    const awaiting = presentTask({ ...revised, revisions: [{ revisionNumber: 2, planVersion: null }], task: { ...revised.task, current_plan_version: 1, state: 'planning' } });
    expect(awaiting.answers).toEqual([]);
    expect(awaiting.artifacts).toEqual([]);
    expect(presentTask({ ...revised, revisions: [{ revisionNumber: 1, planVersion: 1 }] }).answers).toEqual([]);
  });

  it('folds quality process JSON by provenance while keeping requested JSON downloadable', () => {
    const presentation = presentTask(mixedDetail);
    expect(presentation.artifacts.map(artifact => artifact.id)).toEqual(['requested-json']);
    expect(presentation.supportingArtifacts.map(artifact => artifact.id)).toEqual(['process-assessment', 'process-criteria']);
    const markup = render(mixedDetail);
    const processReports = markup.match(/<details class="supporting-artifacts"[^>]*>[\s\S]*?<\/details>/)?.[0];
    expect(processReports).toBeDefined();
    expect(processReports).not.toMatch(/^<details[^>]*\sopen/);
    expect(processReports).toContain('过程报告');
    expect(processReports).toContain('quality-assessment.json');
    expect(processReports).toContain('下载');
    expect(processReports).not.toContain('results.json');
    expect(markup).toContain('<strong>results.json</strong>');
    const requested = presentTask({ ...mixedDetail, artifacts: [{ ...artifacts[0], id: 'user-quality-json', taskNodeId: 'producer-current' }] });
    expect(requested.artifacts.map(artifact => artifact.id)).toEqual(['user-quality-json']);
  });

  it('keeps producer bodies ahead of their quality review and excludes consumed drafts', () => {
    const presentation = presentTask({ ...detail, artifacts: [], nodes: [
      { ...qualityNode, depends_on: ['final-answer'], output: { output: { summary: '质检摘要' } } },
      { id: 'draft', plan_id: 'plan-current', node_key: 'draft-answer', capability: 'document.write', state: 'completed', output: { output: { answer: '前置草稿' } } },
      { id: 'final', plan_id: 'plan-current', node_key: 'final-answer', capability: 'document.write', state: 'completed', depends_on: ['draft-answer'], output: { output: { answer: analysisBody } } },
      { id: 'independent', plan_id: 'plan-current', node_key: 'independent-answer', capability: 'document.write', state: 'completed', output: { output: { answer: '独立补充说明' } } },
    ] });
    expect(presentation.answers.map(answer => answer.body)).toEqual([analysisBody, '独立补充说明']);
  });

  it('does not let retrieved background summaries hide substantive quality-only analysis', () => {
    const presentation = presentTask({ ...detail, nodes: [
      { id: 'retrieval', plan_id: 'plan-current', node_key: 'retrieve', capability: 'knowledge.retrieve', state: 'completed', output: { output: { summary: '已检索到背景资料' } } },
      { ...qualityNode, depends_on: ['retrieve'] },
    ] });
    expect(presentation.answers).toHaveLength(1);
    expect(presentation.answers[0]?.body).toContain(analysisBody);
  });

  it('escapes raw HTML and rejects active Markdown links while preserving readable text', () => {
    const markup = render({ ...detail, delivery: { revisionNumber: 1, answers: [{ nodeKey: 'answer', title: '答复', format: 'markdown',
      body: '<script>alert(1)</script>\n\n[危险链接](javascript:alert) 与 [来源](https://example.com/report)\n\n```html\n<img src=x onerror=alert(1)>\n```',
    }], artifactIds: [], supportingArtifactIds: [] } });
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('href="https://example.com/report"');
  });
});
