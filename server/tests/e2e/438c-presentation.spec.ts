import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';

import { CodexPlannerService } from '../../apps/control-plane/src/planning/codex-planner.service';
import { validateTaskPlan, type ReadyCapability } from '../../packages/agent-protocol/src/index';
import type { CodexRunner } from '../../packages/codex-runtime/src/index';

const readyCapabilities: ReadyCapability[] = [
  { agentId: 'ragflow-knowledge', version: '1.0.0', displayName: 'RAGFlow 知识查询', runtime: 'native', capability: 'knowledge.retrieve', inputSchema: Type.Object({ query: Type.String({ minLength: 1 }) }), resultSchema: Type.Object({ evidence: Type.Array(Type.Object({ source: Type.String(), excerpt: Type.String() })) }) },
  { agentId: 'ppt-maker', version: '1.0.1', displayName: 'PPT 制作', runtime: 'codex', capability: 'presentation.create', inputSchema: Type.Object({ brief: Type.String({ minLength: 1 }), title: Type.String(), referenceMaterials: Type.Array(Type.String()) }), resultSchema: Type.Object({ artifacts: Type.Array(Type.Object({ path: Type.String() })) }) },
  { agentId: 'quality-management', version: '1.0.1', displayName: '质量管理与验收', runtime: 'codex', capability: 'quality.define_and_verify', inputSchema: Type.Object({ requirements: Type.String({ minLength: 1 }), targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }), resultSchema: Type.Object({ passed: Type.Boolean() }) },
];

const output = {
  intent: '制作 438c 项目介绍 PPT',
  summary: '先从企业知识库按背景和里程碑两个角度收集证据，再生成并验收 PPT。',
  deliverables: ['presentation.pptx'],
  assumptions: ['仅使用已检索证据中的企业事实'],
  risks: ['知识库资料不足时，PPT 必须明确标记缺口。'],
  nodeReasons: [
    { nodeId: 'retrieve-background', reason: '收集项目背景与目标' },
    { nodeId: 'retrieve-milestones', reason: '收集时间节点与阶段成果' },
    { nodeId: 'create-presentation', reason: '基于两组已核实证据生成 PPT' },
    { nodeId: 'verify-presentation', reason: '按任务需求验收最终 PPT' },
  ],
  planJson: JSON.stringify({
    version: 'v1',
    nodes: [
      { id: 'retrieve-background', type: 'agent_call', capability: 'knowledge.retrieve', input: { query: '438c 项目背景、建设目标、主要能力' }, workspace: { mode: 'isolated' } },
      { id: 'retrieve-milestones', type: 'agent_call', capability: 'knowledge.retrieve', input: { query: '438c 项目时间、里程碑、阶段成果' }, workspace: { mode: 'isolated' } },
      { id: 'create-presentation', type: 'agent_call', capability: 'presentation.create', dependsOn: ['retrieve-background', 'retrieve-milestones'], input: { brief: '依据可追溯知识证据制作 438c 项目介绍。资料不足时不得编造。', title: '438c 项目介绍', referenceMaterials: [] }, inputBindings: [{ target: 'referenceMaterials', fromNode: 'retrieve-background', source: 'evidence', format: 'evidence_markdown' }, { target: 'referenceMaterials', fromNode: 'retrieve-milestones', source: 'evidence', format: 'evidence_markdown' }], workspace: { mode: 'isolated' } },
      { id: 'verify-presentation', type: 'agent_call', capability: 'quality.define_and_verify', dependsOn: ['create-presentation'], input: { requirements: '内容完整、事实可追溯、版式专业，并明确资料缺口。', targets: [] }, inputBindings: [{ target: 'targets', fromNode: 'create-presentation', source: 'artifact', artifactPath: 'presentation.pptx', format: 'artifact_paths' }], workspace: { mode: 'isolated' } },
      { id: 'finish', type: 'end', dependsOn: ['verify-presentation'] },
    ],
  }),
};

describe('438c presentation orchestration contract', () => {
  it('requires a multi-retrieval, Codex PPT and quality graph instead of substituting one fixed retrieval', async () => {
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: JSON.stringify(output) }) };
    const planner = new CodexPlannerService(runner);

    const planned = await planner.plan({ task: { id: 'task-438c', goal: '制作一个关于438c项目介绍的PPT', acceptanceMode: 'platform_auto' }, capabilities: readyCapabilities, workspacePath: '/tmp/task-438c' });
    const compiled = validateTaskPlan(planned.plan, readyCapabilities);
    const agentNodes = compiled.nodes.filter((node) => node.type === 'agent_call');

    expect(agentNodes.filter((node) => node.capability === 'knowledge.retrieve')).toHaveLength(2);
    expect(agentNodes.find((node) => node.id === 'create-presentation')).toMatchObject({ agentId: 'ppt-maker', agentVersion: '1.0.1', dependsOn: ['retrieve-background', 'retrieve-milestones'] });
    expect(agentNodes.find((node) => node.id === 'verify-presentation')).toMatchObject({ agentId: 'quality-management', inputBindings: [expect.objectContaining({ source: 'artifact', artifactPath: 'presentation.pptx' })] });
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt).toContain('quality.define_and_verify');
  });
});
