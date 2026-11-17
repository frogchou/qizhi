import { describe, expect, it } from 'vitest';

import { projectWorkflowStages } from '../../apps/control-plane/src/tasks/task-monitor';

describe('task monitor projection', () => {
  it('projects persisted agent events into an inspectable end-to-end workflow', () => {
    const stages = projectWorkflowStages({
      task: { state: 'accepted', created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:00:09.000Z' },
      nodes: [{ id: 'node-1', node_key: 'knowledge.retrieve', state: 'completed', created_at: '2026-11-11T10:00:02.000Z', updated_at: '2026-11-11T10:00:08.000Z' }],
      attempts: [{ instance_id: 'instance-1', state: 'completed', created_at: '2026-11-11T10:00:02.000Z', updated_at: '2026-11-11T10:00:08.000Z' }],
      events: [
        { instance_id: 'instance-1', sequence: 1, event_type: 'started', payload: { capability: 'knowledge.retrieve' }, occurred_at: '2026-11-11T10:00:02.000Z' },
        { instance_id: 'instance-1', sequence: 2, event_type: 'progress', payload: { stage: 'retrieving_knowledge' }, occurred_at: '2026-11-11T10:00:04.000Z' },
        { instance_id: 'instance-1', sequence: 4, event_type: 'completed', payload: { status: 'succeeded' }, occurred_at: '2026-11-11T10:00:08.000Z' },
      ],
    });

    expect(stages.map((stage) => stage.key)).toEqual(['signal_received', 'intent_analysis', 'orchestration', 'agent_execution', 'acceptance']);
    expect(stages[3]).toMatchObject({ state: 'succeeded', durationMs: 6_000, details: expect.arrayContaining([expect.stringContaining('retrieving_knowledge')]) });
    expect(stages[4]).toMatchObject({ state: 'succeeded' });
  });

  it('marks the running stage as failed when an attempt has failed', () => {
    const stages = projectWorkflowStages({ task: { state: 'failed', created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:00:03.000Z' }, nodes: [{ id: 'node-1', node_key: 'knowledge.retrieve', state: 'failed', created_at: '2026-11-11T10:00:02.000Z', updated_at: '2026-11-11T10:00:03.000Z' }], attempts: [{ instance_id: 'instance-1', state: 'failed', created_at: '2026-11-11T10:00:02.000Z', updated_at: '2026-11-11T10:00:03.000Z' }], events: [] });
    expect(stages.find((stage) => stage.key === 'agent_execution')).toMatchObject({ state: 'failed' });
    expect(stages.find((stage) => stage.key === 'acceptance')).toMatchObject({ state: 'failed' });
  });

  it('summarizes every node in a compiled graph instead of treating the first node as the whole task', () => {
    const stages = projectWorkflowStages({
      task: { state: 'running', created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:02:00.000Z' },
      nodes: [
        { id: 'retrieve-background', node_key: 'retrieve-background', capability: 'knowledge.retrieve', state: 'completed', created_at: '2026-11-11T10:00:05.000Z', updated_at: '2026-11-11T10:00:20.000Z' },
        { id: 'retrieve-milestones', node_key: 'retrieve-milestones', capability: 'knowledge.retrieve', state: 'completed', created_at: '2026-11-11T10:00:05.000Z', updated_at: '2026-11-11T10:00:22.000Z' },
        { id: 'make-ppt', node_key: 'make-ppt', capability: 'presentation.create', state: 'running', created_at: '2026-11-11T10:00:23.000Z', updated_at: '2026-11-11T10:02:00.000Z' },
        { id: 'verify', node_key: 'verify', capability: 'quality.define_and_verify', state: 'pending', created_at: '2026-11-11T10:00:23.000Z', updated_at: '2026-11-11T10:00:23.000Z' },
      ],
      attempts: [
        { task_node_id: 'retrieve-background', instance_id: 'instance-background', state: 'completed' },
        { task_node_id: 'retrieve-milestones', instance_id: 'instance-milestones', state: 'completed' },
        { task_node_id: 'make-ppt', instance_id: 'instance-ppt', state: 'leased' },
      ],
      events: [{ instance_id: 'instance-ppt', sequence: 1, event_type: 'progress', payload: { stage: 'codex_generating_presentation' }, occurred_at: '2026-11-11T10:01:00.000Z' }],
    });

    expect(stages.find((stage) => stage.key === 'orchestration')?.details.join(' ')).toContain('4 个节点');
    expect(stages.find((stage) => stage.key === 'agent_execution')).toMatchObject({ state: 'running' });
    expect(stages.find((stage) => stage.key === 'agent_execution')?.details.join(' ')).toContain('presentation.create');
  });

  it('explains that a durable task is waiting for user input instead of treating it as stalled', () => {
    const stages = projectWorkflowStages({
      task: { state: 'awaiting_user_input', created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:02:00.000Z' },
      nodes: [{ id: 'node-1', node_key: 'confirm-audience', state: 'awaiting_user_input', created_at: '2026-11-11T10:00:05.000Z', updated_at: '2026-11-11T10:02:00.000Z' }],
      attempts: [{ state: 'yielded' }], events: [], interactions: [{ state: 'pending', source: 'agent', title: '确认目标受众' }],
    });
    expect(stages.find((stage) => stage.key === 'agent_execution')).toMatchObject({ state: 'awaiting_user_input' });
    expect(stages.find((stage) => stage.key === 'agent_execution')?.details.join(' ')).toContain('确认目标受众');
    expect(stages.find((stage) => stage.key === 'acceptance')).toMatchObject({ state: 'pending' });
  });
});
