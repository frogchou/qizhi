import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CapabilityCatalogService } from '../../apps/control-plane/src/planning/capability-catalog.service';
import { CodexPlannerService } from '../../apps/control-plane/src/planning/codex-planner.service';
import { PlanningService } from '../../apps/control-plane/src/planning/planning.service';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import type { CodexRunner } from '../../packages/codex-runtime/src/index';
import { output } from './codex-planner.spec';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const roots: string[] = [];

const schemas = {
  knowledge: { inputSchema: Type.Object({ query: Type.String({ minLength: 1 }) }, { additionalProperties: false }), resultSchema: Type.Object({ evidence: Type.Array(Type.Object({ source: Type.String() })) }) },
  presentation: { inputSchema: Type.Object({ brief: Type.String({ minLength: 1 }), title: Type.String(), referenceMaterials: Type.Array(Type.String()) }, { additionalProperties: false }), resultSchema: Type.Object({ artifacts: Type.Array(Type.Object({ path: Type.String() })) }) },
};

function responseWithPlan(plan: unknown) {
  return { ...output, planJson: JSON.stringify(plan) };
}

function responsePlan(): Record<string, any> {
  return JSON.parse(output.planJson) as Record<string, any>;
}

beforeAll(async () => { await dataSource.initialize(); });
afterAll(async () => { await dataSource.destroy(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function seedReadyCatalog(): Promise<void> {
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  for (const [agentId, version, displayName, capability, schema] of [
    ['ragflow-knowledge', '1.0.0', '知识库查询', 'knowledge.retrieve', schemas.knowledge],
    ['ppt-maker', '1.0.1', 'PPT 制作', 'presentation.create', schemas.presentation],
  ] as const) {
    await dataSource.query(`INSERT INTO agents (id, display_name) VALUES ($1,$2)`, [agentId, displayName]);
    await dataSource.query(`INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ($1,$2,$3,'ready',$4::jsonb)`, [
      `${agentId}@${version}`, agentId, version, JSON.stringify({ agentId, version, displayName, runtime: agentId === 'ppt-maker' ? 'codex' : 'native', capabilities: [{ name: capability }], ...schema }),
    ]);
  }
}

async function taskEnvironment() {
  await seedReadyCatalog();
  const root = await mkdtemp(join(tmpdir(), 'mg-planning-'));
  roots.push(root);
  const workspaces = new TaskWorkspaceService({ root });
  const task = await workspaces.create({ id: 'task-438c', goal: '制作一个关于438c项目介绍的PPT', acceptanceMode: 'platform_auto' });
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ($1,$2,'platform_auto','planning',$3)`, ['task-438c', '制作一个关于438c项目介绍的PPT', task.root]);
  return { task, workspaces };
}

describe('PlanningService', () => {
  it.each(['你能帮助我做什么？', '请问平台有哪些功能？'])('answers %s from the reviewed catalog without starting Codex', async (goal) => {
    const { workspaces } = await taskEnvironment();
    await dataSource.query("UPDATE tasks SET goal=$1 WHERE id='task-438c'", [goal]);
    const runner = { run: vi.fn() };
    const service = new PlanningService(dataSource, new CapabilityCatalogService(dataSource), new CodexPlannerService(runner), workspaces, new TaskSessionService(workspaces));
    await service.createAndCompile('task-438c');
    const [task] = await dataSource.query("SELECT state, planner_summary FROM tasks WHERE id='task-438c'");
    expect(task.state).toBe('accepted');
    expect(task.planner_summary.summary).toContain('PPT 制作');
    expect(task.planner_summary.summary).toContain('知识库查询');
    expect(runner.run).not.toHaveBeenCalled();
    expect(await dataSource.query("SELECT id FROM task_plans")).toHaveLength(0);
  });
  it('compiles and persists a multi-retrieval → PPT graph with a readable session record', async () => {
    const { task, workspaces } = await taskEnvironment();
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: JSON.stringify(output) }) };
    const service = new PlanningService(dataSource, new CapabilityCatalogService(dataSource), new CodexPlannerService(runner), workspaces, new TaskSessionService(workspaces));

    const compiled = await service.createAndCompile('task-438c');

    expect(compiled.nodes.filter((node) => node.type === 'agent_call')).toHaveLength(3);
    expect(compiled.nodes.find((node) => node.type === 'agent_call' && node.id === 'create-presentation')).toMatchObject({ agentId: 'ppt-maker', agentVersion: '1.0.1' });
    await expect(readFile(join(task.plansPath, 'plan-v1.json'), 'utf8')).resolves.toContain('retrieve-milestones');
    await expect(readFile(join(task.plansPath, 'compiled-plan-v1.json'), 'utf8')).resolves.toContain('ppt-maker');
    await expect(readFile(join(task.sessionPath, 'conversation.jsonl'), 'utf8')).resolves.toContain('规划完成');
    const plans = await dataSource.query<{ plan: object }[]>(`SELECT plan FROM task_plans WHERE task_id='task-438c'`);
    expect(plans).toHaveLength(1);
  });

  it('publishes live Codex planning status into the task activity stream', async () => {
    const { workspaces } = await taskEnvironment();
    const activities = { append: vi.fn().mockResolvedValue(undefined) };
    const runner: CodexRunner = { run: vi.fn(async (input) => {
      await input.onStatus?.({ state: 'running', elapsedMs: 72_000, lastOutputAgeMs: 4_000, outputReceived: true });
      return { lastMessage: JSON.stringify(output) };
    }) };
    const service = new PlanningService(dataSource, new CapabilityCatalogService(dataSource), new CodexPlannerService(runner), workspaces, new TaskSessionService(workspaces), activities as any);

    await service.createAndCompile('task-438c');

    expect(activities.append).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-438c', kind: 'planning_codex_status', state: 'planning',
      message: 'Codex 正在进行中台意图分析，已运行 1分12秒，最近输出 4秒前。',
      detail: expect.objectContaining({ runtime: 'codex', elapsedMs: 72_000, lastOutputAgeMs: 4_000 }),
    }));
  });

  it.each([
    ['invented capability', responseWithPlan({ ...responsePlan(), nodes: [{ ...responsePlan().nodes[0], capability: 'document.write' }] })],
    ['cyclic graph', responseWithPlan({ ...responsePlan(), nodes: [{ ...responsePlan().nodes[0], dependsOn: ['create-presentation'] }, ...responsePlan().nodes.slice(1) ] })],
    ['invalid PPT input', responseWithPlan({ ...responsePlan(), nodes: [...responsePlan().nodes.slice(0, 2), { ...responsePlan().nodes[2], input: { brief: 42, title: '438c', referenceMaterials: [] } }, responsePlan().nodes[3]] })],
    ['non-dependency binding', responseWithPlan({ ...responsePlan(), nodes: [...responsePlan().nodes.slice(0, 2), { ...responsePlan().nodes[2], dependsOn: ['retrieve-project'], inputBindings: [{ target: 'referenceMaterials', fromNode: 'retrieve-milestones', source: 'evidence', format: 'evidence_markdown' }] }, responsePlan().nodes[3]] })],
  ])('repairs one invalid %s plan before saving anything', async (_name, invalidOutput) => {
    const { workspaces } = await taskEnvironment();
    const runner: CodexRunner = { run: vi.fn().mockResolvedValueOnce({ lastMessage: JSON.stringify(invalidOutput) }).mockResolvedValueOnce({ lastMessage: JSON.stringify(output) }) };
    const service = new PlanningService(dataSource, new CapabilityCatalogService(dataSource), new CodexPlannerService(runner), workspaces, new TaskSessionService(workspaces));

    await expect(service.createAndCompile('task-438c')).resolves.toMatchObject({ version: 'v1' });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toContain('修复');
  });

  it('fails visibly after the single permitted repair also violates the catalog', async () => {
    const { task, workspaces } = await taskEnvironment();
    const invalid = responseWithPlan({ ...responsePlan(), nodes: [{ ...responsePlan().nodes[0], capability: 'document.write' }] });
    const runner: CodexRunner = { run: vi.fn().mockResolvedValue({ lastMessage: JSON.stringify(invalid) }) };
    const service = new PlanningService(dataSource, new CapabilityCatalogService(dataSource), new CodexPlannerService(runner), workspaces, new TaskSessionService(workspaces));

    await expect(service.createAndCompile('task-438c')).rejects.toThrow(/document\.write|not ready/i);
    const taskState = await dataSource.query<{ state: string }[]>(`SELECT state FROM tasks WHERE id='task-438c'`);
    expect(taskState[0].state).toBe('planning_failed');
    await expect(readFile(join(task.sessionPath, 'conversation.jsonl'), 'utf8')).resolves.toContain('规划失败');
  });
});
