import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExecutionPanel } from '../../apps/console/src/App';
import { presentTask } from '../../apps/console/src/lib/task-presenter';

const detail = {
  task: { id: 'task-438c', goal: '制作一个关于438c项目介绍的PPT', state: 'running', created_at: '2026-11-11T10:00:00Z', updated_at: '2026-11-11T10:01:20Z' },
  planSummary: { intent: '制作 438c 项目介绍 PPT', summary: '先检索背景和里程碑，再制作并验收 PPT。', deliverables: ['438c项目介绍.pptx'], risks: ['资料不足时请人工补充'] },
  plans: [{ plan: { nodeReasons: { 'retrieve-background': '查找项目背景', 'retrieve-milestones': '查找关键时间节点', 'create-presentation': '用已核实资料制作 PPT', 'quality-check': '检查交付质量' } } }],
  nodes: [
    { id: 'node-background', node_key: 'retrieve-background', capability: 'knowledge.retrieve', agent_id: 'ragflow-knowledge', state: 'completed', created_at: '2026-11-11T10:00:05Z', updated_at: '2026-11-11T10:00:32Z', output: { evidence: [{ title: '438c立项资料' }] } },
    { id: 'node-milestones', node_key: 'retrieve-milestones', capability: 'knowledge.retrieve', agent_id: 'ragflow-knowledge', state: 'completed', created_at: '2026-11-11T10:00:05Z', updated_at: '2026-11-11T10:00:35Z', output: { evidence: [{ title: '438c里程碑' }] } },
    { id: 'node-ppt', node_key: 'create-presentation', capability: 'presentation.create', agent_id: 'ppt-maker', state: 'running', created_at: '2026-11-11T10:00:36Z', updated_at: '2026-11-11T10:01:20Z', output: {} },
    { id: 'node-quality', node_key: 'quality-check', capability: 'quality.define_and_verify', agent_id: 'quality-management', state: 'pending', created_at: '2026-11-11T10:00:36Z', updated_at: '2026-11-11T10:00:36Z', output: {} },
  ],
  attempts: [{ task_node_id: 'node-ppt', instance_id: 'instance-ppt', state: 'leased', attempt_number: 1, created_at: '2026-11-11T10:00:36Z', updated_at: '2026-11-11T10:01:20Z' }],
  events: [{ id: 1, instance_id: 'instance-ppt', event_type: 'progress', payload: { stage: 'codex_generating_presentation' }, occurred_at: '2026-11-11T10:00:50Z' }],
  activities: [
    { id: 1, kind: 'planning_started', state: 'planning', message: '中台开始分析需求、已审核能力及执行依赖。', source: 'control_plane', occurredAt: '2026-11-11T10:00:01Z', detail: {} },
    { id: 2, kind: 'agent_event', state: 'running', message: '智能体上报 progress 状态。', source: 'agent', occurredAt: '2026-11-11T10:00:50Z', detail: { nodeKey: 'create-presentation', eventType: 'progress' } },
  ],
  workflow: [
    { key: 'signal_received', label: '需求接收', state: 'succeeded', startedAt: '2026-11-11T10:00:00Z', endedAt: '2026-11-11T10:00:01Z', durationMs: 1000, details: [] },
    { key: 'intent_analysis', label: '中台意图分析', state: 'succeeded', startedAt: '2026-11-11T10:00:01Z', endedAt: '2026-11-11T10:00:04Z', durationMs: 3000, details: [] },
    { key: 'orchestration', label: '智能体编排', state: 'succeeded', startedAt: '2026-11-11T10:00:04Z', endedAt: '2026-11-11T10:00:05Z', durationMs: 1000, details: [] },
    { key: 'agent_execution', label: '智能体工作', state: 'running', startedAt: '2026-11-11T10:00:05Z', details: [] },
    { key: 'acceptance', label: '结果验收', state: 'pending', startedAt: '2026-11-11T10:00:05Z', details: [] },
  ],
};

describe('task presenter', () => {
  it('turns durable plan, nodes and events into Chinese-readable execution data', () => {
    const presentation = presentTask(detail, Date.parse('2026-11-11T10:02:00Z'));
    expect(presentation.intent).toBe('制作 438c 项目介绍 PPT');
    expect(presentation.nodes.find((node) => node.key === 'create-presentation')).toMatchObject({ reason: '用已核实资料制作 PPT', runtime: 'Codex 运行时', stateLabel: '执行中' });
    expect(presentation.nodes.find((node) => node.key === 'retrieve-background')?.summary).toContain('438c立项资料');
    expect(presentation.debug.events).toHaveLength(1);
    expect(presentation.nodes.find((node) => node.key === 'create-presentation')?.duration).toBe('1分24秒');
    expect(presentation.nodes.find((node) => node.key === 'create-presentation')?.health).toContain('等待首次心跳');
  });

  it('renders readable status, capability reason and runtime before developer JSON', () => {
    const markup = renderToStaticMarkup(createElement(ExecutionPanel, { detail: detail as any, onApprove: () => undefined }));
    expect(markup).toContain('中台意图分析');
    expect(markup).toContain('用已核实资料制作 PPT');
    expect(markup).toContain('Codex 运行时');
    expect(markup).toContain('实时执行时间线');
    expect(markup).toContain('中台开始分析需求、已审核能力及执行依赖。');
    expect(markup).toContain('实时连接');
    expect(markup).toContain('开发者调试信息');
    expect(markup).toContain('实时控制台');
    expect(markup).not.toContain('"node_key"');
  });

  it('shows the separately supervised Codex child as alive with its running time and output freshness', () => {
    const monitored = {
      ...detail,
      attempts: [{ ...detail.attempts[0], last_heartbeat_at: '2026-11-11T10:01:55Z' }],
      events: [...detail.events, {
        id: 2,
        instance_id: 'instance-ppt',
        event_type: 'heartbeat',
        payload: { runtime: 'codex', state: 'running', elapsedMs: 79_000, lastOutputAgeMs: 4_000, outputReceived: true },
        occurred_at: '2026-11-11T10:01:55Z',
      }],
    };

    const presentation = presentTask(monitored, Date.parse('2026-11-11T10:02:00Z'));
    const node = presentation.nodes.find((item) => item.key === 'create-presentation');
    expect(node?.health).toBe('Codex 进程仍在运行 · 已运行 1分19秒 · 最近输出 4秒前');
    expect(node?.summary).toContain('Codex 进程仍在执行');
  });

  it('renders an authenticated delivery area and explicit rework decision after quality failure', () => {
    const failed = {
      ...detail,
      task: { ...detail.task, state: 'awaiting_review' },
      artifacts: [{ id: 'artifact-ppt', fileName: 'presentation.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', revision: 2, sizeBytes: 2048, createdAt: '2026-11-11T10:02:00Z' }, { id: 'artifact-quality', fileName: 'quality-assessment.json', mediaType: 'application/json', revision: 1, sizeBytes: 512, createdAt: '2026-11-11T10:02:00Z' }],
      nodes: detail.nodes.map((node) => node.id === 'node-quality' ? { ...node, state: 'completed', output: { status: 'succeeded', output: { passed: false, summary: '缺少项目里程碑' } } } : node),
    };
    const markup = renderToStaticMarkup(createElement(ExecutionPanel, { detail: failed as any, onApprove: () => undefined }));
    expect(markup).toContain('presentation.pptx');
    expect(markup).toContain('下载');
    expect(markup).toContain('查看内容');
    expect(markup).toContain('根据质检意见返工');
  });
});
