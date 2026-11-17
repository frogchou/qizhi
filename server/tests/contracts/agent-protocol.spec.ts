import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  AgentResultSchema,
  AgentManifestSchema,
  TaskEnvelopeSchema,
  TaskPlanSchema,
  validateTaskPlan,
  validateTaskInputBindings,
  type ReadyCapability,
} from '../../packages/agent-protocol/src/index';

const catalog: ReadyCapability[] = [
  {
    agentId: 'ragflow-knowledge',
    version: '1.0.0',
    capability: 'knowledge.retrieve',
    inputSchema: Type.Object({ query: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    resultSchema: Type.Object({ evidence: Type.Array(Type.Object({ source: Type.String() })) }),
  },
  {
    agentId: 'ppt-maker',
    version: '1.0.1',
    capability: 'presentation.create',
    inputSchema: Type.Object({
      brief: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      referenceMaterials: Type.Array(Type.String()),
    }, { additionalProperties: false }),
    resultSchema: Type.Object({ artifacts: Type.Array(Type.Object({ path: Type.String() })) }),
  },
  {
    agentId: 'quality-management',
    version: '1.0.1',
    capability: 'quality.define_and_verify',
    inputSchema: Type.Object({ requirements: Type.String({ minLength: 1 }), targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false }),
    resultSchema: Type.Object({ passed: Type.Boolean() }),
  },
];

const knowledgePlan = {
  version: 'v1',
  nodes: [
    {
      id: 'retrieve-context',
      type: 'agent_call',
      capability: 'knowledge.retrieve',
      input: { query: '味道府客户资料' },
      workspace: { mode: 'isolated' },
    },
    { id: 'finish', type: 'end', dependsOn: ['retrieve-context'] },
  ],
};

describe('Agent Protocol v1', () => {
  it('accepts a reviewed manifest command and compiles a known capability', () => {
    expect(Value.Check(AgentManifestSchema, {
      protocolVersion: 'v1',
      agentId: 'ragflow-knowledge',
      displayName: 'RAGFlow 知识查询',
      version: '1.0.0',
      runtime: 'native',
      entryCommand: ['node', 'dist/main.js'],
      capabilities: [{ name: 'knowledge.retrieve' }],
    })).toBe(true);
    expect(Value.Check(TaskPlanSchema, knowledgePlan)).toBe(true);

    const compiled = validateTaskPlan(knowledgePlan, catalog);

    expect(compiled.nodes[0]).toMatchObject({
      id: 'retrieve-context',
      capability: 'knowledge.retrieve',
      agentId: 'ragflow-knowledge',
    });
  });

  it('accepts an operational loopback callback address in a task envelope', () => {
    expect(Value.Check(TaskEnvelopeSchema, {
      protocolVersion: 'v1', taskId: 'task-1', taskNodeId: 'node-1', instanceId: 'instance-1', attemptNumber: 1,
      leaseToken: 'lease-token-with-at-least-24-characters', workspacePath: '/tmp/task-1/nodes/node-1',
      input: {}, callback: { url: 'http://127.0.0.1:3010/internal/v1/instances/instance-1/events' },
      resultCallback: { url: 'http://127.0.0.1:3010/internal/v1/instances/instance-1/result' },
    })).toBe(true);
  });

  it('normalizes legacy approval nodes and validates resumable human interaction contracts', () => {
    const legacyApprovalPlan = {
      version: 'v1',
      nodes: [
        { id: 'confirm-audience', type: 'approval', reason: '请确认 PPT 的目标受众。' },
        { id: 'finish', type: 'end', dependsOn: ['confirm-audience'] },
      ],
    };
    const interactionPlan = {
      version: 'v1',
      nodes: [
        {
          id: 'confirm-audience', type: 'human_interaction',
          interaction: {
            kind: 'confirmation', title: '确认目标受众', prompt: '请确认本次 PPT 面向的受众。', responseTarget: 'task.session.audience',
            responseSchema: {
              type: 'object', required: ['decision'], additionalProperties: false,
              properties: { decision: { type: 'string', enum: ['confirm', 'revise'] }, note: { type: 'string', maxLength: 4000 } },
            },
          },
        },
        { id: 'finish', type: 'end', dependsOn: ['confirm-audience'] },
      ],
    };
    const checkpoint = { schemaVersion: 1, resumeKey: 'requirements-round-1', workspaceRelativePath: 'checkpoints/requirements-round-1.json', sha256: 'a'.repeat(64) };

    expect(Value.Check(TaskPlanSchema, interactionPlan)).toBe(true);
    expect(validateTaskPlan(legacyApprovalPlan, catalog).nodes[0]).toMatchObject({
      id: 'confirm-audience', type: 'human_interaction', interaction: { kind: 'confirmation', prompt: '请确认 PPT 的目标受众。' },
    });
    expect(Value.Check(AgentResultSchema, {
      protocolVersion: 'v1', taskId: 'task-1', taskNodeId: 'node-1', instanceId: 'instance-1', status: 'needs_user_input', summary: '缺少目标受众。',
      interaction: interactionPlan.nodes[0].interaction, checkpoint,
    })).toBe(true);
    expect(Value.Check(TaskEnvelopeSchema, {
      protocolVersion: 'v1', taskId: 'task-1', taskNodeId: 'node-1', instanceId: 'instance-2', attemptNumber: 2,
      leaseToken: 'lease-token-with-at-least-24-characters', workspacePath: '/tmp/task-1/nodes/node-1', input: {}, callback: { url: 'http://127.0.0.1:3010/internal/v1/instances/instance-2/events' },
      resume: { fromInteractionId: 'interaction-1', checkpoint, answers: [{ interactionId: 'interaction-1', response: { decision: 'confirm' } }] },
    })).toBe(true);
    expect(Value.Check(TaskPlanSchema, {
      ...interactionPlan,
      nodes: [{ ...interactionPlan.nodes[0], interaction: { ...interactionPlan.nodes[0].interaction, responseTarget: '../outside-task' } }],
    })).toBe(false);
  });

  it('rejects a planner capability that is not in the ready catalog', () => {
    expect(() => validateTaskPlan({
      ...knowledgePlan,
      nodes: [{ ...knowledgePlan.nodes[0], capability: 'document.write' }],
    }, catalog)).toThrow(/not ready/i);
  });

  it('rejects an input that violates the selected agent input schema', () => {
    expect(() => validateTaskPlan({
      ...knowledgePlan,
      nodes: [{ ...knowledgePlan.nodes[0], input: { query: 42 } }],
    }, catalog)).toThrow(/input/i);
  });

  it('rejects a shared workspace that has no explicit sharing group', () => {
    expect(() => validateTaskPlan({
      ...knowledgePlan,
      nodes: [{ ...knowledgePlan.nodes[0], workspace: { mode: 'shared' } }],
    }, catalog)).toThrow(/sharing group/i);
  });

  it('compiles a PPT node that materializes evidence from a dependency', () => {
    const plan = {
      version: 'v1',
      nodes: [
        knowledgePlan.nodes[0],
        {
          id: 'make-presentation',
          type: 'agent_call',
          capability: 'presentation.create',
          dependsOn: ['retrieve-context'],
          input: { brief: '介绍438c项目', title: '438c项目介绍', referenceMaterials: [] },
          inputBindings: [{ target: 'referenceMaterials', fromNode: 'retrieve-context', source: 'evidence', format: 'evidence_markdown' }],
          workspace: { mode: 'isolated' },
        },
        { id: 'finish', type: 'end', dependsOn: ['make-presentation'] },
      ],
    };

    expect(validateTaskPlan(plan, catalog).nodes[1]).toMatchObject({ agentId: 'ppt-maker', capability: 'presentation.create' });
  });

  it('accepts an explicit task-private material binding only for an array input', () => {
    const plan = {
      version: 'v1',
      nodes: [
        {
          id: 'make-presentation', type: 'agent_call', capability: 'presentation.create',
          input: { brief: '基于任务资料介绍栖知', title: '栖知产品介绍', referenceMaterials: [] },
          taskInputBindings: [{ target: 'referenceMaterials', inputId: 'input-private-brief', format: 'task_input_paths' }],
          workspace: { mode: 'isolated' },
        },
        { id: 'finish', type: 'end', dependsOn: ['make-presentation'] },
      ],
    };

    const compiled = validateTaskPlan(plan, catalog);
    expect(compiled.nodes[0]).toMatchObject({ agentId: 'ppt-maker' });
    expect(() => validateTaskInputBindings(plan as any, ['input-private-brief', 'input-not-granted'])).toThrow(/not granted/i);
    expect(() => validateTaskInputBindings(plan as any, ['input-private-brief'])).not.toThrow();
  });

  it('validates a required input array after a declared artifact binding materializes it', () => {
    const plan = {
      version: 'v1',
      nodes: [
        { id: 'make-presentation', type: 'agent_call', capability: 'presentation.create', input: { brief: '介绍438c项目', title: '438c项目介绍', referenceMaterials: [] }, workspace: { mode: 'isolated' } },
        {
          id: 'verify-presentation', type: 'agent_call', capability: 'quality.define_and_verify', dependsOn: ['make-presentation'],
          input: { requirements: '检查内容完整性和可追溯性', targets: [] },
          inputBindings: [{ target: 'targets', fromNode: 'make-presentation', source: 'artifact', format: 'artifact_paths' }],
          workspace: { mode: 'isolated' },
        },
        { id: 'finish', type: 'end', dependsOn: ['verify-presentation'] },
      ],
    };

    expect(validateTaskPlan(plan, catalog).nodes[1]).toMatchObject({ agentId: 'quality-management', capability: 'quality.define_and_verify' });
  });

  it('rejects malformed input bindings at the protocol boundary', () => {
    expect(Value.Check(TaskPlanSchema, {
      version: 'v1',
      nodes: [{
        id: 'make-presentation', type: 'agent_call', capability: 'presentation.create',
        input: { brief: '介绍438c项目', title: '438c项目介绍', referenceMaterials: [] },
        inputBindings: [{ target: 'referenceMaterials', fromNode: 42, source: 'evidence', format: 'evidence_markdown' }],
        workspace: { mode: 'isolated' },
      }],
    })).toBe(false);
  });

  it('requires exactly one terminal end node that covers every planned node', () => {
    expect(() => validateTaskPlan({
      version: 'v1',
      nodes: [knowledgePlan.nodes[0]],
    }, catalog)).toThrow(/terminal end/i);
  });

  it('rejects bindings that do not depend on their source node', () => {
    expect(() => validateTaskPlan({
      version: 'v1',
      nodes: [
        knowledgePlan.nodes[0],
        {
          id: 'make-presentation', type: 'agent_call', capability: 'presentation.create',
          input: { brief: '介绍438c项目', title: '438c项目介绍', referenceMaterials: [] },
          inputBindings: [{ target: 'referenceMaterials', fromNode: 'retrieve-context', source: 'evidence', format: 'evidence_markdown' }],
          workspace: { mode: 'isolated' },
        },
      ],
    }, catalog)).toThrow(/depend/i);
  });

  it('rejects absolute and traversing artifact bindings', () => {
    for (const artifactPath of ['/etc/passwd', '../secret.txt']) {
      expect(() => validateTaskPlan({
        version: 'v1',
        nodes: [
          knowledgePlan.nodes[0],
          {
            id: 'make-presentation', type: 'agent_call', capability: 'presentation.create', dependsOn: ['retrieve-context'],
            input: { brief: '介绍438c项目', title: '438c项目介绍', referenceMaterials: [] },
            inputBindings: [{ target: 'referenceMaterials', fromNode: 'retrieve-context', source: 'artifact', artifactPath, format: 'artifact_paths' }],
            workspace: { mode: 'isolated' },
          },
        ],
      }, catalog)).toThrow(/artifact path/i);
    }
  });
});
