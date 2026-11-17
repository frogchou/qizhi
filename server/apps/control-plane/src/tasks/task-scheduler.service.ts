import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DataSource } from 'typeorm';

import type { CompiledTaskPlan, TaskEnvelope } from '../../../../packages/agent-protocol/src/index.js';
import type { TaskActivityInput } from '../observability/task-activity.service.js';
import { TaskInteractionService } from './task-interaction.service.js';
import { CodexCliRunner, type CodexRunner } from '../../../../packages/codex-runtime/src/index.js';
import { assessDelivery, type Criterion, type DeliveryNode } from './delivery-acceptance.js';
import { TaskSessionService } from './task-session.service.js';
import { TaskWorkspaceService } from './task-workspace.service.js';

export type NodeManagerLauncher = {
  startInstance(input: { instanceId: string; agentId: string; version: string; workspacePath: string; environmentFile: string; envelopePath: string }): Promise<{ instanceId: string; unitName: string }>;
  stopInstance(instanceId: string): Promise<void>;
};

export type SchedulerConfig = {
  workspaceRoot: string;
  callbackBaseUrl: string;
  runtimeRoot?: string;
  leaseSeconds?: number;
  environment?: Record<string, string>;
};

type TaskActivityAppender = { append(input: TaskActivityInput): Promise<unknown> };

type TaskRow = { id: string; goal: string; directAnswer?:string; createdAt: Date; acceptanceMode: string; state: string; workspacePath: string; revisionNumber:number };
type PlanRow = { id: string; plan: CompiledTaskPlan & { nodeReasons?: Record<string, string> } };
type NodeRow = {
  id: string; nodeKey: string; state: string; input: Record<string, unknown>; output: Record<string, unknown> | null;
  nodeType: string; capability: string | null; agentId: string | null; agentVersion: string | null; dependsOn: string[]; workspacePath: string | null; rationale: string | null;
};
type AgentNode = Extract<CompiledTaskPlan['nodes'][number], { type: 'agent_call' }>;
type HumanInteractionNode = Extract<CompiledTaskPlan['nodes'][number], { type: 'human_interaction' }>;
type BoundTaskInput = { id: string; displayName: string; sourceType: string; mediaType: string; sizeBytes: number | string; sha256: string; workspaceRelativePath: string };
type MaterializedNodeInput = { input: Record<string, unknown>; taskInputs: NonNullable<TaskEnvelope['taskInputs']> };

/**
 * Durable scheduler. The database owns every transition; systemd is only the
 * process launcher. It never imports agent implementation modules.
 */
export class TaskSchedulerService {
  private readonly advances = new Map<string, Set<Promise<void>>>();
  private readonly evaluating = new Map<string,{revisionNumber:number; controller:AbortController; done:Promise<void>}>();
  private readonly runtimeRoot: string;
  private readonly leaseSeconds: number;

  public constructor(
    private readonly dataSource: DataSource,
    private readonly workspaces: TaskWorkspaceService,
    private readonly sessions: TaskSessionService,
    private readonly nodeManager: NodeManagerLauncher,
    private readonly config: SchedulerConfig,
    private readonly activities?: TaskActivityAppender,
    private readonly interactions?: TaskInteractionService,
    private readonly evaluator: CodexRunner = new CodexCliRunner(),
  ) {
    this.runtimeRoot = config.runtimeRoot ?? join(dirname(config.workspaceRoot), 'runtime', 'instances');
    this.leaseSeconds = config.leaseSeconds ?? 600;
  }

  public async advance(taskId: string): Promise<void> {
    const active = this.advances.get(taskId) ?? new Set<Promise<void>>();
    this.advances.set(taskId, active);
    const operation = this.advanceOnce(taskId);
    active.add(operation);
    try { await operation; } finally {
      active.delete(operation);
      if (!active.size) this.advances.delete(taskId);
    }
  }

  public abortAcceptance(taskId:string) { this.evaluating.get(taskId)?.controller.abort(); }

  public async stopActiveAttempts(taskId: string): Promise<void> {
    this.evaluating.get(taskId)?.controller.abort();
    // Drain start handshakes before stopping the corresponding transient units.
    await Promise.allSettled([...(this.advances.get(taskId) ?? [])]);
    const attempts = await this.dataSource.query<Array<{ id: string; instance_id: string }>>(`
      SELECT a.id,a.instance_id FROM task_attempts a JOIN task_nodes n ON n.id=a.task_node_id
      JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 AND a.state IN ('leased','stopping')
    `, [taskId]);
    const stops = await Promise.allSettled(attempts.map(async (attempt) => {
      await this.dataSource.query("UPDATE task_attempts SET state='stopping', updated_at=now() WHERE id=$1 AND state='leased'", [attempt.id]);
      await this.nodeManager.stopInstance(attempt.instance_id);
      await this.dataSource.query("UPDATE task_attempts SET state='cancelled', updated_at=now() WHERE id=$1 AND state='stopping'", [attempt.id]);
    }));
    if (stops.some((stop) => stop.status === 'rejected')) throw new Error('Instance stop failed.');
  }

  private async advanceOnce(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!['planned', 'running'].includes(task.state)) return;
    const plan = await this.currentPlan(taskId);
    await this.ensurePlanNodes(task, plan);
    let nodes = await this.nodes(taskId);
    if (!nodes.length && plan.plan.nodes.every(n=>n.type==='end')) {
      await this.evaluate(task,nodes);
      return;
    }

    if (await this.processQualityDecision(task, nodes)) {
      await this.advance(taskId);
      return;
    }
    const failed = nodes.filter(n=>n.state==='failed');
    if (failed.length && nodes.every(n=>['completed','failed'].includes(n.state)) &&
        failed.every(n=>n.capability==='research.web' || n.nodeKey.startsWith('supplement-')) && nodes.some(n=>n.output)) {
      await this.evaluate(task,nodes);
      return;
    }
    if (failed.some(n=>n.capability!=='research.web' && !n.nodeKey.startsWith('supplement-')) || (failed.length && !plan.plan.nodes.some(n=>n.id.startsWith('supplement-')))) {
      await this.finishTask(task, 'failed', '有智能体节点执行失败，任务已停止。');
      return;
    }

    const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
    const agentRunnable = nodes.filter((node) => node.nodeType === 'agent_call' && node.state === 'pending' && node.dependsOn.every((dependency) => dependencyCompleted(dependency, byKey)));
    if (agentRunnable.length > 0) {
      await Promise.all(agentRunnable.map(async (node) => this.launch(task, plan, node, byKey)));
    }

    const interactionNode = nodes.find((node) => node.nodeType === 'human_interaction' && node.state === 'pending' && node.dependsOn.every((dependency) => dependencyCompleted(dependency, byKey)));
    if (interactionNode) {
      await this.pauseForPlanInteraction(task, plan, interactionNode);
      return;
    }

    nodes = await this.nodes(taskId);
    if (nodes.length > 0 && nodes.every((node) => node.state === 'completed') && endReached(plan.plan, nodes)) {
      await this.evaluate(task,nodes);
    }
  }

  /** Explicit operator maintenance for a specific historical automatic decision. */
  public async reassessAutomatic(taskId:string) {
    const task=await this.loadTask(taskId);
    const [eligible]=await this.dataSource.query(`SELECT id FROM tasks WHERE id=$1 AND state='accepted'
      AND acceptance_mode='platform_auto' AND EXISTS(SELECT 1 FROM task_activity_events WHERE task_id=$1 AND kind='task_accepted')
      AND NOT EXISTS(SELECT 1 FROM task_activity_events WHERE task_id=$1 AND kind='human_accepted')
      AND NOT EXISTS(SELECT 1 FROM task_acceptance_rounds WHERE task_id=$1)`,[taskId]);
    if (!eligible) throw new Error('Only an unreviewed legacy automatic acceptance may be reassessed.');
    await this.evaluate(task,await this.nodes(taskId));
  }

  private async evaluate(task:TaskRow,nodes:NodeRow[]): Promise<void> {
    const active=this.evaluating.get(task.id);
    if(active) {
      if(active.revisionNumber===task.revisionNumber) return active.done;
      await active.done;
      return this.evaluate(task,nodes);
    }
    const controller=new AbortController();
    // Register before awaiting the database, so a concurrent stop always sees this evaluation.
    const done=this.loadTask(task.id).then(latest => {
      if (!controller.signal.aborted && latest.state === task.state && latest.revisionNumber===task.revisionNumber) return this.evaluateOnce(task,nodes,controller.signal);
    }).finally(()=>this.evaluating.delete(task.id));
    this.evaluating.set(task.id,{revisionNumber:task.revisionNumber,controller,done});
    return done;
  }

  private async evaluateOnce(task:TaskRow,nodes:NodeRow[],signal:AbortSignal) {
    const [previous]=await this.dataSource.query('SELECT round,criteria,decision FROM task_acceptance_rounds WHERE task_id=$1 AND revision_number=$2 ORDER BY round DESC LIMIT 1',[task.id,task.revisionNumber]);
    const [{round}]=await this.dataSource.query('SELECT coalesce(max(round),0)+1 AS round FROM task_acceptance_rounds WHERE task_id=$1',[task.id]);
    if(previous && previous.decision!=='supplement') return;
    await this.activities?.append({taskId:task.id,kind:'acceptance_started',state:task.state,message:'中台正在按原始需求逐项核对交付证据。',source:'control_plane'});
    const material:DeliveryNode[]=[...nodes];
    if (task.directAnswer) material.unshift({nodeKey:'control-plane-answer',capability:'control_plane.answer',output:{output:{summary:task.directAnswer}}});
    signal.throwIfAborted();
    const {criteria,assessment}=await assessDelivery(this.evaluator,task.workspacePath,task.goal,new Date(task.createdAt).toISOString(),material,(previous?.criteria ?? []) as Criterion[],signal,async (stage,status) => {
      if (signal.aborted) return;
      const action = stage === 'criteria' ? '提取验收标准' : '核对交付证据';
      const seconds = Math.floor(status.elapsedMs / 1_000);
      await this.activities?.append({taskId:task.id,kind:'acceptance_progress',state:task.state,source:'control_plane',
        message: status.state === 'started' ? `中台开始${action}。` : `中台仍在${action}，本步骤已用 ${seconds} 秒。`,
        detail:{round,stage,runtime:'codex',elapsedMs:status.elapsedMs,outputReceived:status.outputReceived}});
    });
    const unresolved=criteria.some(c=>c.priority==='required' && assessment.items.find(i=>i.id===c.id)?.status!=='met');
    const state=assessment.review || unresolved || task.acceptanceMode==='human_review' || task.revisionNumber>0 ? 'awaiting_review':'accepted';
    const message=state==='accepted'?'中台已核实原始需求的必需项。':'已保留当前交付和逐项核验记录，等待管理员决定。';
    signal.throwIfAborted();
    const saved=await this.dataSource.transaction(async manager=>{
      const [,changed]=await manager.query('UPDATE tasks SET state=$2,updated_at=now() WHERE id=$1 AND state=$3 AND revision_number=$4',[task.id,state,task.state,task.revisionNumber]);
      if(!changed) return false;
      await manager.query('INSERT INTO task_acceptance_rounds(id,task_id,round,criteria,assessment,revision_number) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)',[randomUUID(),task.id,round,JSON.stringify(criteria),JSON.stringify(assessment),task.revisionNumber]);
      return true;
    });
    if(!saved) return;
    await this.sessions.append(task.id,{kind:'delivery_assessed',message,detail:{round}});
    await this.sessions.writeStateSnapshot(task.id,{taskId:task.id,state,round,message});
    await this.activities?.append({taskId:task.id,kind:'delivery_assessed',state,message,detail:{round},source:'control_plane'});
  }

  private async ensurePlanNodes(task: TaskRow, plan: PlanRow): Promise<void> {
    const reasons = plan.plan.nodeReasons ?? {};
    for (const item of plan.plan.nodes) {
      if (item.type === 'end') continue;
      if (item.type === 'agent_call') {
        const node = item as AgentNode & { agentId: string; agentVersion: string };
        if (!node.agentId || !node.agentVersion) throw new Error(`Compiled node ${node.id} has no selected reviewed agent version.`);
        const workspacePath = await this.workspaces.createNodeWorkspace(task.id, node.id,task.revisionNumber);
        await this.insertPlanNode(plan, node, {
          input: node.input, capability: node.capability, agentId: node.agentId, agentVersion: node.agentVersion,
          workspacePath, displayTitle: node.capability, rationale: reasons[node.id] ?? null,
        });
        continue;
      }
      if (item.type === 'human_interaction') {
        const node = item as HumanInteractionNode;
        await this.insertPlanNode(plan, node, {
          input: {}, capability: null, agentId: null, agentVersion: null, workspacePath: null,
          displayTitle: node.interaction.title, rationale: reasons[node.id] ?? null,
        });
        continue;
      }
      throw new Error(`Unsupported compiled runtime node type: ${item.type}.`);
    }
  }

  private async insertPlanNode(plan: PlanRow, node: Exclude<CompiledTaskPlan['nodes'][number], { type: 'end' }>, values: { input: Record<string, unknown>; capability: string | null; agentId: string | null; agentVersion: string | null; workspacePath: string | null; displayTitle: string; rationale: string | null }): Promise<void> {
    await this.dataSource.query(`
      INSERT INTO task_nodes (id, plan_id, node_key, node_type, definition, state, input, capability, agent_id, agent_version, depends_on, workspace_path, display_title, rationale)
      VALUES ($1,$2,$3,$4,$5::jsonb,'pending',$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13)
      ON CONFLICT (plan_id, node_key) DO NOTHING
    `, [randomUUID(), plan.id, node.id, node.type, JSON.stringify(node), JSON.stringify(values.input), values.capability, values.agentId, values.agentVersion, JSON.stringify(node.dependsOn ?? []), values.workspacePath, values.displayTitle, values.rationale]);
  }

  public async resumeInteraction(taskId: string, interactionId: string): Promise<void> {
    if (!this.interactions) throw new Error('Task interaction service is not configured.');
    const interaction = await this.interactions.get(taskId, interactionId);
    const claimed = await this.interactions.claimResume({ taskId, interactionId });
    if (!claimed.claimed) return;
    const isAgentInteraction = interaction.source === 'agent';
    const changed = isAgentInteraction
      ? await this.dataSource.query(`UPDATE task_nodes SET state='pending', output=NULL, updated_at=now() WHERE id=$1 AND state='awaiting_user_input'`, [requiredNodeId(claimed.interaction)])
      : await this.dataSource.query(`UPDATE task_nodes SET state='completed', output=$2::jsonb, updated_at=now() WHERE id=$1 AND state='awaiting_user_input'`, [
        requiredNodeId(claimed.interaction),
        JSON.stringify({ status: 'succeeded', output: { responseTarget: claimed.interaction.responseTarget, response: claimed.interaction.answer ?? {}, message: claimed.interaction.answerMessage ?? null }, evidence: [], artifacts: [] }),
      ]);
    const count = Array.isArray(changed) ? Number(changed[1] ?? 0) : 0;
    if (count !== 1) throw new Error('Waiting interaction node is no longer resumable.');
    await this.dataSource.query(`UPDATE tasks SET state='planned', updated_at=now() WHERE id=$1 AND state='awaiting_user_input'`, [taskId]);
    const resumeMessage = isAgentInteraction ? `已根据用户回答重新调度智能体：${claimed.interaction.title}。` : `已根据用户回答恢复执行：${claimed.interaction.title}。`;
    await this.sessions.append(taskId, { kind: 'human_interaction_resumed', message: resumeMessage, detail: { interactionId, planNodeKey: claimed.interaction.planNodeKey, source: claimed.interaction.source } });
    await this.sessions.writeStateSnapshot(taskId, { taskId, state: 'planned', message: resumeMessage, interactionId });
    await this.activities?.append({ taskId, kind: 'human_interaction_resumed', state: 'planned', message: `已根据用户回答恢复节点：${claimed.interaction.planNodeKey}。`, detail: { interactionId, planNodeKey: claimed.interaction.planNodeKey, source: claimed.interaction.source }, source: 'control_plane' });
    await this.advance(taskId);
  }

  private async pauseForPlanInteraction(task: TaskRow, plan: PlanRow, node: NodeRow): Promise<void> {
    if (!this.interactions) throw new Error('Task interaction service is not configured.');
    const definition = plan.plan.nodes.find((item): item is HumanInteractionNode => item.type === 'human_interaction' && item.id === node.nodeKey);
    if (!definition) throw new Error(`Interaction node ${node.nodeKey} is missing from the compiled plan.`);
    const changed = await this.dataSource.query(`UPDATE task_nodes SET state='awaiting_user_input', updated_at=now() WHERE id=$1 AND state='pending'`, [node.id]);
    if (Array.isArray(changed) && Number(changed[1] ?? 0) !== 1) return;
    try {
      const interaction = await this.interactions.requestPlanInteraction({ taskId: task.id, taskPlanId: plan.id, taskNodeId: node.id, planNodeKey: node.nodeKey, request: definition.interaction });
      const [, changed] = await this.dataSource.query(`UPDATE tasks SET state='awaiting_user_input', updated_at=now() WHERE id=$1 AND state IN ('planned','running','awaiting_user_input')`, [task.id]);
      if (!changed) return;
      await this.sessions.writeStateSnapshot(task.id, { taskId: task.id, state: 'awaiting_user_input', message: `正在等待用户输入：${interaction.title}。`, interactionId: interaction.id, planNodeKey: node.nodeKey });
      await this.sessions.append(task.id, { kind: 'human_interaction_waiting', message: `任务已暂停，等待用户输入：${interaction.title}。`, detail: { interactionId: interaction.id, planNodeKey: node.nodeKey, source: 'control_plane' } });
      await this.activities?.append({ taskId: task.id, kind: 'human_interaction_waiting', state: 'awaiting_user_input', message: `任务已暂停，等待用户输入：${interaction.title}。`, detail: { interactionId: interaction.id, planNodeKey: node.nodeKey, source: 'control_plane' }, source: 'control_plane' });
    } catch (error) {
      await this.dataSource.query(`UPDATE task_nodes SET state='pending', updated_at=now() WHERE id=$1 AND state='awaiting_user_input'`, [node.id]);
      throw error;
    }
  }

  private async launch(task: TaskRow, plan: PlanRow, node: NodeRow, byKey: Map<string, NodeRow>): Promise<void> {
    if (!node.workspacePath || !node.capability || !node.agentId || !node.agentVersion) throw new Error(`Agent node ${node.nodeKey} has incomplete reviewed-agent binding.`);
    const [, claimed] = await this.dataSource.query(`UPDATE task_nodes SET state='leasing', updated_at=now() WHERE id=$1 AND state='pending'`, [node.id]);
    if (!claimed) return;
    let attemptId: string | undefined;
    try {
      const unavailable=await this.dataSource.query("SELECT status FROM agent_versions WHERE agent_id=$1 AND version=$2 AND status<>'ready'",[node.agentId,node.agentVersion]);
      if(unavailable.length)throw new Error(`任务绑定的智能体版本不可用（${unavailable[0].status}）`);
      const materialized = await this.materializeBindings(task, plan.plan, node, byKey);
      const input = materialized.input;
      const instanceId = randomUUID();
      const leaseToken = `${randomUUID()}${randomUUID()}`;
      const attempts = await this.dataSource.query<{ next: number }[]>(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM task_attempts WHERE task_node_id=$1`, [node.id]);
      const attemptNumber = Number(attempts[0].next);
      const deadlineAt = new Date(Date.now() + this.leaseSeconds * 1_000).toISOString();
      const resume = await this.interactions?.resumeContextForNode({ taskId: task.id, taskNodeId: node.id });
      const envelope: TaskEnvelope = {
        protocolVersion: 'v1', taskId: task.id, taskNodeId: node.id, instanceId, attemptNumber, leaseToken,
        workspacePath: node.workspacePath, taskRoot: task.workspacePath, nodeWorkspacePath: node.workspacePath,
        input, ...(materialized.taskInputs.length ? { taskInputs: materialized.taskInputs } : {}), callback: { url: `${this.config.callbackBaseUrl}/internal/v1/instances/${instanceId}/events` },
        resultCallback: { url: `${this.config.callbackBaseUrl}/internal/v1/instances/${instanceId}/result` }, deadlineAt,
        ...(resume ? { resume } : {}),
      };
      const envelopePath = await this.workspaces.writeNodeEnvelope(task.id, node.nodeKey, envelope,task.revisionNumber);
      const environmentFile = await this.writeEnvironmentFile(instanceId, envelopePath);
      attemptId = randomUUID();
      await this.dataSource.query(`INSERT INTO task_attempts (id, task_node_id, instance_id, attempt_number, lease_token, lease_expires_at, state) VALUES ($1,$2,$3,$4,$5,$6,'leased')`, [attemptId, node.id, instanceId, attemptNumber, leaseToken, deadlineAt]);
      await this.dataSource.query(`UPDATE task_nodes SET state='running', input=$2::jsonb, updated_at=now() WHERE id=$1`, [node.id, JSON.stringify(input)]);
      const [, active] = await this.dataSource.query(`UPDATE tasks SET state=CASE WHEN state='awaiting_user_input' THEN state ELSE 'running' END, updated_at=now() WHERE id=$1 AND state IN ('running','planned','awaiting_user_input')`, [task.id]);
      if (!active) {
        await this.dataSource.query("UPDATE task_attempts SET state='cancelled' WHERE id=$1", [attemptId]);
        return;
      }
      if (materialized.taskInputs.length > 0) {
        await Promise.all(materialized.taskInputs.map((material) => this.dataSource.query(
          `INSERT INTO task_input_audits (task_id, task_input_id, action, actor_subject, detail) VALUES ($1,$2,'bound_to_node','control_plane',$3::jsonb)`,
          [task.id, material.id, JSON.stringify({ nodeKey: node.nodeKey, capability: node.capability, relativePath: material.path, sha256: material.sha256 })],
        )));
        await this.sessions.append(task.id, { kind: 'task_inputs_bound', message: `已向节点 ${node.nodeKey} 授予 ${materialized.taskInputs.length} 项任务私有资料。`, detail: { nodeKey: node.nodeKey, inputIds: materialized.taskInputs.map((item) => item.id) } });
        await this.activities?.append({ taskId: task.id, kind: 'task_inputs_bound', state: 'leasing', message: `已向智能体 ${node.capability} 授予 ${materialized.taskInputs.length} 项任务私有资料。`, detail: { nodeKey: node.nodeKey, inputCount: materialized.taskInputs.length, inputIds: materialized.taskInputs.map((item) => item.id) }, source: 'control_plane' });
      }
      await this.activities?.append({ taskId: task.id, kind: 'agent_launch_requested', state: 'leasing', message: `中台已请求启动智能体：${node.capability}。`, detail: { nodeKey: node.nodeKey, instanceId, attemptNumber, agentId: node.agentId, agentVersion: node.agentVersion }, source: 'control_plane' });
      const started = await this.nodeManager.startInstance({ instanceId, agentId: node.agentId, version: node.agentVersion, workspacePath: node.workspacePath, environmentFile, envelopePath });
      await this.dataSource.query(`UPDATE task_attempts SET unit_name=$2, updated_at=now() WHERE id=$1`, [attemptId, started.unitName]);
      await this.sessions.append(task.id, { kind: 'node_launch_accepted', message: `节点管理服务已创建智能体运行单元：${node.capability}。`, detail: { nodeKey: node.nodeKey, attemptNumber, runtime: 'independent_service', unitName: started.unitName } });
      await this.activities?.append({ taskId: task.id, kind: 'agent_launch_accepted', state: 'running', message: `节点管理服务已创建运行单元，等待 ${node.capability} 的首次心跳。`, detail: { nodeKey: node.nodeKey, instanceId, attemptNumber, agentId: node.agentId, agentVersion: node.agentVersion, unitName: started.unitName }, source: 'node_manager' });
    } catch (error) {
      const message = publicMessage(error);
      if (attemptId) await this.dataSource.query(`UPDATE task_attempts SET state='failed', updated_at=now() WHERE id=$1`, [attemptId]);
      await this.dataSource.query(`UPDATE task_nodes SET state='failed', output=$2::jsonb, updated_at=now() WHERE id=$1`, [node.id, JSON.stringify({ error: message })]);
      await this.sessions.append(task.id, { kind: 'node_launch_failed', message: `无法启动 ${node.capability}：${message}`, detail: { nodeKey: node.nodeKey } });
      await this.activities?.append({ taskId: task.id, kind: 'agent_launch_failed', state: 'failed', message: `无法启动智能体 ${node.capability}：${message}`, detail: { nodeKey: node.nodeKey, agentId: node.agentId, agentVersion: node.agentVersion }, source: 'control_plane' });
      await this.finishTask(task, 'failed', `智能体 ${node.capability} 未能启动，任务已停止。`);
    }
  }

  private async materializeBindings(task: TaskRow, plan: CompiledTaskPlan & { nodeReasons?: Record<string, string> }, node: NodeRow, byKey: Map<string, NodeRow>): Promise<MaterializedNodeInput> {
    if (!node.workspacePath) throw new Error(`Agent node ${node.nodeKey} has no workspace.`);
    const agent = plan.nodes.find((item): item is AgentNode => item.type === 'agent_call' && item.id === node.nodeKey);
    if (!agent) throw new Error(`Node ${node.nodeKey} is missing from compiled plan.`);
    const input = structuredClone(node.input);
    for (const binding of agent.inputBindings ?? []) {
      const source = byKey.get(binding.fromNode);
      if (!source?.output) throw new Error(`Binding source ${binding.fromNode} has no durable result.`);
      const inputDirectory = join(node.workspacePath, 'input');
      await mkdir(inputDirectory, { recursive: true });
      if (binding.source === 'evidence') {
        const evidence = array(source.output.evidence);
        const path = join(inputDirectory, `${safeFile(binding.target)}-from-${safeFile(source.nodeKey)}.md`);
        await writeFile(path, evidenceMarkdown(evidence), 'utf8');
        appendInput(input, binding.target, relative(node.workspacePath, path));
      } else {
        const artifacts = array(source.output.artifacts).filter((item) => typeof object(item).path === 'string');
        const artifact = binding.artifactPath
          ? artifacts.find((item) => object(item).path === binding.artifactPath)
          : artifacts.length === 1 ? artifacts[0] : undefined;
        if (!artifact || typeof object(artifact).path !== 'string') {
          const expected = binding.artifactPath
            ? `artifact ${binding.artifactPath}`
            : 'exactly one artifact because no artifactPath was declared';
          throw new Error(`Binding source ${binding.fromNode} did not return ${expected}.`);
        }
        if (!source.workspacePath) throw new Error(`Binding source ${binding.fromNode} has no workspace.`);
        const sourcePath = containedPath(source.workspacePath, object(artifact).path as string);
        const destination = join(inputDirectory, `${safeFile(binding.target)}-from-${safeFile(source.nodeKey)}-${safeFile(basename(sourcePath))}`);
        await copyFile(sourcePath, destination);
        appendInput(input, binding.target, relative(node.workspacePath, destination));
      }
    }
    const taskInputs = new Map<string, NonNullable<TaskEnvelope['taskInputs']>[number]>();
    for (const binding of agent.taskInputBindings ?? []) {
      const rows = await this.dataSource.query<BoundTaskInput[]>(`
        SELECT id, display_name AS "displayName", source_type AS "sourceType", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256, workspace_relative_path AS "workspaceRelativePath"
        FROM task_inputs WHERE task_id=$1 AND id=$2
      `, [task.id, binding.inputId]);
      const material = rows[0];
      if (!material) throw new Error(`Task input ${binding.inputId} is not available to node ${node.nodeKey}.`);
      const sourcePath = await this.workspaces.resolveTaskPath(task.id, material.workspaceRelativePath);
      const inputDirectory = join(node.workspacePath, 'input', 'task-inputs');
      await mkdir(inputDirectory, { recursive: true });
      const destination = join(inputDirectory, `${safeFile(material.id)}-${safeFile(basename(sourcePath))}`);
      await copyFile(sourcePath, destination);
      if(material.sourceType==='agent_artifact') {
        const bytes=await readFile(destination);
        if(bytes.length!==Number(material.sizeBytes)||createHash('sha256').update(bytes).digest('hex')!==material.sha256)
          throw new Error('上一版归档制品校验失败，无法授予该节点。');
      }
      const nodeRelativePath = relative(node.workspacePath, destination);
      appendInput(input, binding.target, nodeRelativePath);
      taskInputs.set(material.id, {
        id: material.id,
        displayName: material.displayName,
        sourceType: material.sourceType,
        mediaType: material.mediaType,
        sizeBytes: Number(material.sizeBytes),
        sha256: material.sha256,
        path: nodeRelativePath,
      });
    }
    return { input, taskInputs: [...taskInputs.values()] };
  }

  private async processQualityDecision(task: TaskRow, nodes: NodeRow[]): Promise<boolean> {
    const quality = nodes.find((node) => node.capability === 'quality.define_and_verify' && node.state === 'completed' && qualityFailed(node.output));
    if (!quality) return false;
    const sourceKey = quality.dependsOn.find((dependency) => nodes.find((node) => node.nodeKey === dependency)?.capability === 'presentation.create');
    await this.finishTask(task, 'awaiting_review', sourceKey
      ? '质量验收未通过，已保留当前交付与质检意见，等待管理员确认当前交付或发起返工。'
      : '质量验收未通过，等待管理员确认当前交付。');
    return true;
  }

  private async finishTask(task: TaskRow, state: 'accepted' | 'failed' | 'awaiting_review', message: string): Promise<void> {
    const [, changed] = await this.dataSource.query(`UPDATE tasks SET state=$2, updated_at=now() WHERE id=$1 AND state IN ('planned','running','awaiting_user_input')`, [task.id, state]);
    if (!changed) return;
    await this.sessions.append(task.id, { kind: `task_${state}`, message });
    await this.sessions.writeStateSnapshot(task.id, { taskId: task.id, state, message });
    await this.activities?.append({ taskId: task.id, kind: `task_${state}`, state, message, source: 'control_plane' });
  }

  private async loadTask(taskId: string): Promise<TaskRow> {
    const rows = await this.dataSource.query<TaskRow[]>(`SELECT id, coalesce(effective_goal,goal) AS goal, revision_number AS "revisionNumber",
      CASE WHEN planner_summary->>'mode'='direct_answer' THEN planner_summary->>'summary' END AS "directAnswer", created_at AS "createdAt", acceptance_mode AS "acceptanceMode", state, workspace_path AS "workspacePath" FROM tasks WHERE id=$1`, [taskId]);
    if (!rows[0]) throw new Error('Task not found.');
    return rows[0];
  }

  private async currentPlan(taskId: string): Promise<PlanRow> {
    const rows = await this.dataSource.query<PlanRow[]>(`SELECT id, plan FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 1`, [taskId]);
    if (!rows[0]) throw new Error('Task has no compiled plan.');
    const plan=json(rows[0].plan) as PlanRow['plan'];
    const supplements=await this.dataSource.query("SELECT supplement_node FROM task_acceptance_rounds WHERE task_id=$1 AND revision_number=(SELECT revision_number FROM tasks WHERE id=$1) AND supplement_node IS NOT NULL ORDER BY round",[taskId]);
    return { ...rows[0], plan:{...plan,nodes:[...plan.nodes,...supplements.map((r:{supplement_node:AgentNode})=>r.supplement_node)]} };
  }

  private async nodes(taskId: string): Promise<NodeRow[]> {
    const rows = await this.dataSource.query<NodeRow[]>(`
      SELECT n.id, n.node_key AS "nodeKey", n.state, n.input, n.output, n.node_type AS "nodeType", n.capability AS "capability", n.agent_id AS "agentId", n.agent_version AS "agentVersion", n.depends_on AS "dependsOn", n.workspace_path AS "workspacePath", n.rationale
      FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 AND p.version=(SELECT max(version) FROM task_plans WHERE task_id=$1) ORDER BY n.created_at
    `, [taskId]);
    return rows.map((row) => ({ ...row, input: json(row.input) as Record<string, unknown>, output: row.output ? json(row.output) as Record<string, unknown> : null, dependsOn: json(row.dependsOn) as string[] }));
  }

  private async writeEnvironmentFile(instanceId: string, envelopePath: string): Promise<string> {
    await mkdir(this.runtimeRoot, { recursive: true });
    const path = join(this.runtimeRoot, `${instanceId}.env`);
    const values = { ...this.config.environment, MG_TASK_ENVELOPE_PATH: envelopePath };
    const body = Object.entries(values).map(([key, value]) => `${key}=${quoteEnvironment(value)}`).join('\n');
    await writeFile(path, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
    return path;
  }
}

function endReached(plan: CompiledTaskPlan, nodes: NodeRow[]): boolean {
  const complete = new Set(nodes.filter((node) => node.state === 'completed').map((node) => node.nodeKey));
  const ends = plan.nodes.filter((node) => node.type === 'end');
  return ends.length === 0 || ends.some((node) => (node.dependsOn ?? []).every((dependency) => complete.has(dependency)));
}
function dependencyCompleted(dependency: string, byKey: Map<string, NodeRow>): boolean { return byKey.get(dependency)?.state === 'completed'; }
function requiredNodeId(interaction: { taskNodeId?: string }): string { if (!interaction.taskNodeId) throw new Error('Plan interaction has no runtime node.'); return interaction.taskNodeId; }
function qualityFailed(output: Record<string, unknown> | null): boolean { return output?.status === 'succeeded' && object(output.output).passed === false; }
function json(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function appendInput(input: Record<string, unknown>, target: string, value: string): void { input[target] = Array.isArray(input[target]) ? [...input[target] as unknown[], value] : [value]; }
function safeFile(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'value'; }
function containedPath(root: string, child: string): string { if (!child || isAbsolute(child)) throw new Error('Agent artifact path must be relative.'); const resolved = resolve(root, child); if (relative(root, resolved).startsWith('..') || isAbsolute(relative(root, resolved))) throw new Error('Agent artifact path escapes its workspace.'); return resolved; }
function evidenceMarkdown(evidence: unknown[]): string { return evidence.map((item, index) => { const value = object(item); return `## 证据 ${index + 1}\n来源：${String(value.source ?? 'unknown')}\n\n${String(value.excerpt ?? '')}\n`; }).join('\n') || '# 未检索到可用证据\n'; }
function quoteEnvironment(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')}"`; }
function publicMessage(error: unknown): string { return (error instanceof Error ? error.message : '未知错误').replace(/\s+/g, ' ').slice(0, 1_000); }
