import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { TaskSchedulerService, type NodeManagerLauncher } from '../../apps/control-plane/src/tasks/task-scheduler.service';
import { TaskSessionService } from '../../apps/control-plane/src/tasks/task-session.service';
import { TaskInteractionService } from '../../apps/control-plane/src/tasks/task-interaction.service';
import { TaskWorkspaceService } from '../../apps/control-plane/src/tasks/task-workspace.service';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const roots: string[] = [];

beforeAll(async () => { await dataSource.initialize(); });
afterAll(async () => { await dataSource.destroy(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function environment(plan: unknown = compiledPlan()) {
  await dataSource.dropDatabase();
  await dataSource.runMigrations();
  const root = await mkdtemp(join(tmpdir(), 'mg-scheduler-'));
  roots.push(root);
  const workspaces = new TaskWorkspaceService({ root });
  const task = await workspaces.create({ id: 'task-438c', goal: '制作438c项目介绍PPT', acceptanceMode: 'platform_auto' });
  await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-438c','制作438c项目介绍PPT','platform_auto','planned',$1)`, [task.root]);
  const inputPath = await workspaces.resolveTaskPath('task-438c', join('inputs', 'input-private-brief', 'original', '栖知资料.txt'));
  await mkdir(dirname(inputPath), { recursive: true });
  await writeFile(inputPath, '栖知是一套企业知识与智能体协作平台。', { encoding: 'utf8' });
  await dataSource.query(`INSERT INTO task_inputs (id, task_id, source_type, display_name, original_filename, media_type, size_bytes, sha256, workspace_relative_path, source_ref, provenance) VALUES ('input-private-brief','task-438c','uploaded_file','栖知资料','栖知资料.txt','text/plain',$1,$2,$3,'{}'::jsonb,'{}'::jsonb)`, [Buffer.byteLength('栖知是一套企业知识与智能体协作平台。'), sha256('栖知是一套企业知识与智能体协作平台。'), join('inputs', 'input-private-brief', 'original', '栖知资料.txt')]);
  await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('plan-438c','task-438c',1,$1::jsonb,'compiled')`, [JSON.stringify(plan)]);
  const launcher: NodeManagerLauncher = { startInstance: vi.fn(async (input) => ({ instanceId: input.instanceId, unitName: `mg-agent-${input.instanceId}` })), stopInstance: vi.fn() };
  const activities = { append: vi.fn().mockResolvedValue(undefined) };
  const sessions = new TaskSessionService(workspaces);
  const interactions = new TaskInteractionService(dataSource, workspaces, sessions, activities as any);
  const scheduler = new (TaskSchedulerService as any)(dataSource, workspaces, sessions, launcher, {
    workspaceRoot: root, callbackBaseUrl: 'http://127.0.0.1:3010', runtimeRoot: join(root, 'runtime'), leaseSeconds: 120,
  }, activities, interactions);
  return { task, workspaces, launcher, scheduler, activities, interactions };
}

describe('TaskSchedulerService', () => {
  it('drains outstanding starts before stopping both units and keeps later dispatches idle', async () => {
    const { scheduler, launcher } = await environment();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(launcher.startInstance).mockImplementation(async ({ instanceId }) => {
      await gate;
      return { instanceId, unitName: 'mg-agent-' + instanceId };
    });
    const launching = scheduler.advance('task-438c');
    await vi.waitFor(() => expect(launcher.startInstance).toHaveBeenCalledTimes(2));
    await dataSource.query("UPDATE tasks SET state='stopping' WHERE id='task-438c'");
    const stopping = scheduler.stopActiveAttempts('task-438c');
    expect(launcher.stopInstance).not.toHaveBeenCalled();
    release();
    await Promise.all([launching, stopping]);
    await scheduler.advance('task-438c');
    expect(launcher.stopInstance).toHaveBeenCalledTimes(2);
    expect(launcher.startInstance).toHaveBeenCalledTimes(2);
    expect(await dataSource.query("SELECT id FROM task_attempts WHERE state='cancelled'")).toHaveLength(2);
  });
  it('records a readable activity when an independent agent is launched', async () => {
    const { scheduler, activities } = await environment();

    await scheduler.advance('task-438c');

    expect(activities.append).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-438c', kind: 'agent_launch_accepted', state: 'running', source: 'node_manager' }));
  });

  it('launches independent retrievals in parallel, waits for evidence bindings, and stops for human decision after a quality failure', async () => {
    const { workspaces, launcher, scheduler } = await environment();

    await scheduler.advance('task-438c');
    expect(launcher.startInstance).toHaveBeenCalledTimes(2);
    let nodes = await nodesForTask();
    expect(nodes.map((node) => [node.node_key, node.state])).toEqual(expect.arrayContaining([
      ['retrieve-background', 'running'], ['retrieve-milestones', 'running'], ['create-presentation', 'pending'], ['quality-check', 'pending'],
    ]));

    await completeNode('retrieve-background', { evidence: [{ source: 'ragflow:background', excerpt: '438c 项目背景' }], artifacts: [] });
    await completeNode('retrieve-milestones', { evidence: [{ source: 'ragflow:milestones', excerpt: '438c 于 2026 年立项' }], artifacts: [] });
    await scheduler.advance('task-438c');
    expect(launcher.startInstance).toHaveBeenCalledTimes(3);
    nodes = await nodesForTask();
    const ppt = nodes.find((node) => node.node_key === 'create-presentation')!;
    expect(ppt.input.referenceMaterials).toHaveLength(3);
    await expect(Promise.all(ppt.input.referenceMaterials.map((path: string) => readFile(join(ppt.workspace_path, path), 'utf8')))).resolves.toHaveLength(3);
    expect(ppt.input.referenceMaterials).toEqual(expect.arrayContaining([expect.stringContaining('task-inputs')]));
    const envelope = JSON.parse(await readFile(join(ppt.workspace_path, 'envelope.json'), 'utf8'));
    expect(envelope.taskInputs).toEqual([expect.objectContaining({ id: 'input-private-brief', displayName: '栖知资料' })]);
    const inputAudits = await dataSource.query<Array<{ action: string; detail: { nodeKey: string } }>>(`SELECT action, detail FROM task_input_audits WHERE task_id='task-438c'`);
    expect(inputAudits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'bound_to_node', detail: expect.objectContaining({ nodeKey: 'create-presentation' }) })]));

    const pptWorkspace = await workspaces.resolveTaskPath('task-438c', join('nodes', 'create-presentation'));
    const pptPath = join(pptWorkspace, 'presentation.pptx');
    await writeFile(pptPath, 'pptx content');
    await completeNode('create-presentation', { evidence: [], artifacts: [{ path: 'presentation.pptx', sha256: sha256('pptx content') }] });
    await scheduler.advance('task-438c');
    expect(launcher.startInstance).toHaveBeenCalledTimes(4);
    const quality = (await nodesForTask()).find((node) => node.node_key === 'quality-check')!;
    expect(quality.input.targets).toHaveLength(1);
    await expect(readFile(join(quality.workspace_path, quality.input.targets[0]), 'utf8')).resolves.toBe('pptx content');

    await completeNode('quality-check', { evidence: [], artifacts: [], output: { passed: false } });
    await scheduler.advance('task-438c');
    const state = await dataSource.query<{ state: string }[]>(`SELECT state FROM tasks WHERE id='task-438c'`);
    expect(state[0].state).toBe('awaiting_review');
    expect(launcher.startInstance).toHaveBeenCalledTimes(4);
    expect((await nodesForTask()).find((node) => node.node_key === 'create-presentation')).toMatchObject({ state: 'completed' });
  });

  it('pauses a plan-native human interaction and launches only its unblocked downstream node after an answer', async () => {
    const { launcher, scheduler, interactions } = await environment(compiledPlanWithAudienceConfirmation());

    await scheduler.advance('task-438c');
    expect(launcher.startInstance).toHaveBeenCalledTimes(1);
    await completeNode('retrieve-background', { evidence: [{ source: 'ragflow:background', excerpt: '438c 项目背景' }], artifacts: [] });

    await scheduler.advance('task-438c');
    expect(launcher.startInstance).toHaveBeenCalledTimes(1);
    const [waiting] = await interactions.pendingForTask('task-438c');
    expect(waiting).toMatchObject({ source: 'control_plane', planNodeKey: 'confirm-audience', state: 'pending' });
    expect((await dataSource.query<{ state: string }[]>(`SELECT state FROM tasks WHERE id='task-438c'`))[0].state).toBe('awaiting_user_input');

    await interactions.respond({ taskId: 'task-438c', interactionId: waiting.id, response: { decision: 'confirm' }, idempotencyKey: 'audience-answer-1' });
    await scheduler.resumeInteraction('task-438c', waiting.id);
    expect(launcher.startInstance).toHaveBeenCalledTimes(2);
    expect(await interactions.pendingForTask('task-438c')).toEqual([]);
    expect((await nodesForTask()).find((node) => node.node_key === 'confirm-audience')).toMatchObject({ state: 'completed' });
  });
});

async function nodesForTask(): Promise<Array<{ id: string; node_key: string; state: string; input: any; workspace_path: string }>> {
  return dataSource.query(`SELECT n.id, n.node_key, n.state, n.input, n.workspace_path FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id='task-438c' ORDER BY n.node_key`);
}

async function completeNode(key: string, result: { evidence: unknown[]; artifacts: unknown[]; output?: Record<string, unknown> }): Promise<void> {
  await dataSource.query(`UPDATE task_nodes SET state='completed', output=$2::jsonb, updated_at=now() WHERE node_key=$1`, [key, JSON.stringify({ status: 'succeeded', output: result.output ?? {}, evidence: result.evidence, artifacts: result.artifacts })]);
  await dataSource.query(`UPDATE task_attempts SET state='completed', result_received_at=now(), updated_at=now() WHERE task_node_id=(SELECT id FROM task_nodes WHERE node_key=$1) AND state='leased'`, [key]);
}

function compiledPlan() {
  return {
    version: 'v1', nodeReasons: {}, planner: { summary: '测试图' }, nodes: [
      { id: 'retrieve-background', type: 'agent_call', capability: 'knowledge.retrieve', agentId: 'ragflow-knowledge', agentVersion: '1.0.0', input: { query: '438c 项目背景' }, workspace: { mode: 'isolated' } },
      { id: 'retrieve-milestones', type: 'agent_call', capability: 'knowledge.retrieve', agentId: 'ragflow-knowledge', agentVersion: '1.0.0', input: { query: '438c 时间里程碑' }, workspace: { mode: 'isolated' } },
      { id: 'create-presentation', type: 'agent_call', capability: 'presentation.create', agentId: 'ppt-maker', agentVersion: '1.0.1', dependsOn: ['retrieve-background', 'retrieve-milestones'], input: { brief: '介绍 438c', title: '438c 项目介绍', referenceMaterials: [] }, inputBindings: [
        { target: 'referenceMaterials', fromNode: 'retrieve-background', source: 'evidence', format: 'evidence_markdown' },
        { target: 'referenceMaterials', fromNode: 'retrieve-milestones', source: 'evidence', format: 'evidence_markdown' },
      ], taskInputBindings: [{ target: 'referenceMaterials', inputId: 'input-private-brief', format: 'task_input_paths' }], workspace: { mode: 'isolated' } },
      { id: 'quality-check', type: 'agent_call', capability: 'quality.define_and_verify', agentId: 'quality-management', agentVersion: '1.0.1', dependsOn: ['create-presentation'], input: { requirements: 'PPT 应有可追溯项目资料', targets: [] }, inputBindings: [{ target: 'targets', fromNode: 'create-presentation', source: 'artifact', format: 'artifact_paths' }], workspace: { mode: 'isolated' } },
      { id: 'finish', type: 'end', dependsOn: ['quality-check'] },
    ],
  };
}

function compiledPlanWithAudienceConfirmation() {
  return {
    version: 'v1', nodeReasons: {}, planner: { summary: '测试人工交互图' }, nodes: [
      { id: 'retrieve-background', type: 'agent_call', capability: 'knowledge.retrieve', agentId: 'ragflow-knowledge', agentVersion: '1.0.0', input: { query: '438c 项目背景' }, workspace: { mode: 'isolated' } },
      {
        id: 'confirm-audience', type: 'human_interaction', dependsOn: ['retrieve-background'],
        interaction: {
          kind: 'confirmation', title: '确认目标受众', prompt: '请确认 PPT 的目标受众。', responseTarget: 'task.session.audience',
          responseSchema: { type: 'object', required: ['decision'], additionalProperties: false, properties: { decision: { type: 'string', enum: ['confirm', 'revise'] } } },
        },
      },
      { id: 'create-presentation', type: 'agent_call', capability: 'presentation.create', agentId: 'ppt-maker', agentVersion: '1.0.1', dependsOn: ['retrieve-background', 'confirm-audience'], input: { brief: '介绍 438c', title: '438c 项目介绍', referenceMaterials: [] }, workspace: { mode: 'isolated' } },
      { id: 'finish', type: 'end', dependsOn: ['create-presentation'] },
    ],
  };
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
