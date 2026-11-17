import { Type } from '@sinclair/typebox';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ReadyCapability } from '../../packages/agent-protocol/src/index';
import type { CodexRunner } from '../../packages/codex-runtime/src/index';
import { CodexPlannerService } from '../../apps/control-plane/src/planning/codex-planner.service';

const capabilities: ReadyCapability[] = [
  {
    agentId: 'ragflow-knowledge', version: '1.0.0', displayName: '知识库查询', runtime: 'native', capability: 'knowledge.retrieve',
    inputSchema: Type.Object({ query: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    resultSchema: Type.Object({ evidence: Type.Array(Type.Object({ source: Type.String() })) }),
  },
  {
    agentId: 'ppt-maker', version: '1.0.1', displayName: 'PPT 制作', runtime: 'codex', capability: 'presentation.create',
    inputSchema: Type.Object({ brief: Type.String({ minLength: 1 }), title: Type.String(), referenceMaterials: Type.Array(Type.String()) }, { additionalProperties: false }),
    resultSchema: Type.Object({ artifacts: Type.Array(Type.Object({ path: Type.String() })) }),
  },
];

const output = {
  intent: '基于企业知识库制作 438c 项目介绍 PPT',
  summary: '先并行检索项目背景与时间里程碑，再制作演示文稿。',
  deliverables: ['438c项目介绍.pptx'],
  assumptions: ['以知识库证据为准'],
  risks: ['资料不足时需要人工补充'],
  nodeReasons: [
    { nodeId: 'retrieve-project', reason: '获取项目基本信息' },
    { nodeId: 'retrieve-milestones', reason: '获取可靠的时间节点' },
    { nodeId: 'create-presentation', reason: '将已核实资料转成 PPT' },
  ],
  planJson: JSON.stringify({
    version: 'v1',
    nodes: [
      { id: 'retrieve-project', type: 'agent_call', capability: 'knowledge.retrieve', input: { query: '438c 项目名称、背景、目标' }, workspace: { mode: 'isolated' } },
      { id: 'retrieve-milestones', type: 'agent_call', capability: 'knowledge.retrieve', input: { query: '438c 项目时间、里程碑、进展' }, workspace: { mode: 'isolated' } },
      {
        id: 'create-presentation', type: 'agent_call', capability: 'presentation.create', dependsOn: ['retrieve-project', 'retrieve-milestones'],
        input: { brief: '基于知识库中已证实的 438c 项目资料制作介绍 PPT。', title: '438c 项目介绍', referenceMaterials: [] },
        inputBindings: [
          { target: 'referenceMaterials', fromNode: 'retrieve-project', source: 'evidence', format: 'evidence_markdown' },
          { target: 'referenceMaterials', fromNode: 'retrieve-milestones', source: 'evidence', format: 'evidence_markdown' },
        ],
        workspace: { mode: 'isolated' },
      },
      { id: 'finish', type: 'end', dependsOn: ['create-presentation'] },
    ],
  }),
};

describe('CodexPlannerService', () => {
  it('passes only the ready capability catalog to Codex and returns a constrained Chinese planning summary', async () => {
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: JSON.stringify(output) }) };
    const planner = new CodexPlannerService(runner);

    const planned = await planner.plan({
      task: { id: 'task-438c', goal: '制作一个关于438c项目介绍的PPT', acceptanceMode: 'platform_auto' },
      capabilities,
      workspacePath: '/tmp/task-438c',
    });

    expect(planned).toMatchObject({ intent: expect.stringContaining('438c'), summary: expect.stringContaining('检索') });
    expect(planned.nodeReasons).toMatchObject({ 'retrieve-project': '获取项目基本信息' });
    expect(planned.plan.nodes).toHaveLength(4);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: join('/tmp/task-438c', 'plans'),
      outputSchemaPath: expect.stringContaining('planner-output.schema.json'),
      prompt: expect.stringContaining('knowledge.retrieve'),
    }));
    const prompt = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
    const invocation = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect('timeoutMs' in invocation).toBe(false);
    expect(prompt).not.toContain('document.write');
    expect(prompt).toContain('绑定目标必须同时出现在 input 中并以 [] 初始化');
    expect(prompt).toContain('产品、项目等多维事实介绍至少建立两个');
    expect(prompt).toContain('taskInputBindings');
  });

  it('shows a metadata-only list of frozen task materials to the planner', async () => {
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: JSON.stringify(output) }) };
    const planner = new CodexPlannerService(runner);
    await planner.plan({
      task: { id: 'task-1', goal: '依据附件制作介绍', acceptanceMode: 'platform_auto', inputs: [{ id: 'input-brief', displayName: '栖知资料.txt', sourceType: 'uploaded_file', mediaType: 'text/plain', sizeBytes: 42, sha256: 'a'.repeat(64) }] },
      capabilities,
      workspacePath: '/tmp/task-1',
    });
    const prompt = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
    expect(prompt).toContain('栖知资料.txt');
    expect(prompt).toContain('input-brief');
    expect(prompt).not.toContain('附件正文');
  });

  it('requires substantive delivery using the supplied catalog rather than substituting a quality conclusion', async () => {
    const capability = 'available.file_summary';
    const catalog: ReadyCapability[] = [{
      agentId: 'file-reader', version: '1.0.0', capability,
      description: '读取授权文件并交付内容总结与用途说明', runtime: 'codex',
      inputSchema: Type.Object({ requirements: Type.String(), referenceMaterials: Type.Array(Type.String()) }),
      resultSchema: Type.Object({ answer: Type.String() }),
    }];
    const response = { ...output, nodeReasons: [{ nodeId: 'analyze', reason: '读取授权文件并提供完整分析正文' }], planJson: JSON.stringify({ version: 'v1', nodes: [
      { id: 'analyze', type: 'agent_call', capability, input: { requirements: '总结内容并解释用途', referenceMaterials: [] }, taskInputBindings: [{ target: 'referenceMaterials', inputId: 'file-1', format: 'task_input_paths' }], workspace: { mode: 'isolated' } },
      { id: 'finish', type: 'end', dependsOn: ['analyze'] },
    ] }) };
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: JSON.stringify(response) }) };
    const planned = await new CodexPlannerService(runner).plan({
      task: { id: 'task-summary', goal: '总结文件并说明它的用途', acceptanceMode: 'platform_auto', inputs: [{ id: 'file-1', displayName: '说明.md', sourceType: 'uploaded_file', mediaType: 'text/markdown', sizeBytes: 45, sha256: 'a'.repeat(64) }] },
      capabilities: catalog, workspacePath: '/tmp/task-summary',
    });
    const prompt = vi.mocked(runner.run).mock.calls[0][0].prompt;
    expect(prompt).toContain(capability);
    expect(prompt).not.toContain('document.analyze');
    expect(prompt).toContain('完整答复或交付文件');
    expect(prompt).toContain('质量验收结论不能代替用户要求的正文');
    expect(prompt).toContain('先生产实际交付物');
    expect(prompt).toContain('普通文件总结无需强制追加质量节点');
    expect(planned.plan.nodes[0]).toMatchObject({ capability, taskInputBindings: [{ inputId: 'file-1' }] });
  });

  it('rejects malformed planner output rather than treating free text as a plan', async () => {
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: '我建议先查资料。' }) };
    const planner = new CodexPlannerService(runner);

    await expect(planner.plan({ task: { id: 'task-1', goal: '制作PPT', acceptanceMode: 'platform_auto' }, capabilities, workspacePath: '/tmp/task-1' }))
      .rejects.toThrow(/JSON|规划/i);
  });

  it('forwards live Codex process status while generating the execution graph', async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const runner: CodexRunner = { run: vi.fn(async (input) => {
      await input.onStatus?.({ state: 'running', elapsedMs: 62_000, lastOutputAgeMs: 3_000, outputReceived: true });
      return { lastMessage: JSON.stringify(output) };
    }) };
    const planner = new CodexPlannerService(runner);

    await planner.plan({
      task: { id: 'task-438c', goal: '制作一个关于438c项目介绍的PPT', acceptanceMode: 'platform_auto' },
      capabilities,
      workspacePath: '/tmp/task-438c',
      onStatus: (status) => { statuses.push(status); },
    });

    expect(statuses).toEqual([expect.objectContaining({ state: 'running', elapsedMs: 62_000, lastOutputAgeMs: 3_000 })]);
  });

  it('uses a Codex-compatible strict response schema without dynamic object keys', async () => {
    const schema = JSON.parse(await readFile(resolve(process.cwd(), 'apps/control-plane/src/planning/planner-output.schema.json'), 'utf8'));

    expect(schema.properties.nodeReasons).toMatchObject({
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['nodeId', 'reason'] },
    });
    expect(schema.properties.planJson).toMatchObject({ type: 'string', minLength: 2 });
  });
});

export { capabilities, output };
