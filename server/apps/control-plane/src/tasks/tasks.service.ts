import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import { redactOperatorValue, TaskActivityService } from '../observability/task-activity.service.js';
import { CONTROL_PLANE_DATA_SOURCE } from '../registry/registry.service.js';
import { projectWorkflowStages } from './task-monitor.js';
import { TaskOrchestrationService } from './task-orchestration.service.js';
import { TaskSessionService } from './task-session.service.js';
import { TaskWorkspaceService } from './task-workspace.service.js';
import { TaskArtifactService } from './task-artifact.service.js';
import { TaskSchedulerService } from './task-scheduler.service.js';
import { TaskInputService } from './task-input.service.js';
import { TaskInteractionService } from './task-interaction.service.js';
import { requestRevision, type RevisionRequest } from './task-revision.js';
import { buildTaskDelivery } from './delivery-content.js';

export const TASK_RUNTIME_CONFIG = Symbol('TASK_RUNTIME_CONFIG');
export type IntakeSource = 'api' | 'console' | 'qizhi_desktop';
export type TaskRuntimeConfig = {
  ragflowBaseUrl: string;
  ragflowApiKey: string;
  datasetIds: readonly string[];
  workspaceRoot: string;
  codexPlannerTimeoutMs?: number;
  callbackBaseUrl?: string;
  instanceRuntimeRoot?: string;
  agentPackageRoot?: string;
  taskInputMaxFileBytes?: number;
  taskInputMaxCount?: number;
  taskInputMaxTotalBytes?: number;
};

/** Owns user-facing task creation and approval; scheduling stays in TaskSchedulerService. */
@Injectable()
export class TaskService {
  public constructor(
    @Inject(CONTROL_PLANE_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly workspaces: TaskWorkspaceService,
    private readonly sessions: TaskSessionService,
    private readonly orchestration: TaskOrchestrationService,
    private readonly activities: TaskActivityService,
    private readonly artifacts: TaskArtifactService,
    private readonly scheduler: TaskSchedulerService,
    private readonly inputs: TaskInputService,
    private readonly interactions: TaskInteractionService,
  ) {}

  public async createTask(goal: string, acceptanceMode = 'platform_auto', inputIds: readonly string[] = [], sourceSystem: IntakeSource = 'api'): Promise<{ taskId: string; state: string }> {
    if (!['platform_auto', 'human_review'].includes(acceptanceMode)) throw new Error('acceptanceMode must be platform_auto or human_review.');
    const taskId = randomUUID();
    const workspace = await this.workspaces.create({ id: taskId, goal, acceptanceMode });
    let frozenInputs: Awaited<ReturnType<TaskInputService['freezeForTask']>> = [];
    try {
      await this.dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path, source_system) VALUES ($1,$2,$3,'received',$4,$5)`, [taskId, goal, acceptanceMode, workspace.root, sourceSystem]);
      frozenInputs = await this.inputs.freezeForTask(taskId, inputIds);
    } catch (error) {
      await this.dataSource.query(`DELETE FROM tasks WHERE id=$1`, [taskId]);
      await this.workspaces.removeTaskWorkspace(taskId);
      throw error;
    }
    await this.sessions.append(taskId, { kind: 'requirement_received', message: '已接收需求信号，正在由中台分析可用能力并编排任务。' });
    await this.activities.append({ taskId, kind: 'task_received', state: 'received', message: '已接收需求信号，任务工作目录已创建。', source: 'control_plane', detail:{sourceSystem} });
    if (frozenInputs.length > 0) {
      await this.sessions.append(taskId, { kind: 'task_inputs_frozen', message: `已冻结 ${frozenInputs.length} 项任务私有资料，后续智能体仅可按编排授权读取。`, detail: { inputCount: frozenInputs.length, inputIds: frozenInputs.map((input) => input.id) } });
      await this.activities.append({ taskId, kind: 'task_inputs_frozen', state: 'received', message: `已冻结 ${frozenInputs.length} 项任务私有资料。`, detail: { inputCount: frozenInputs.length, inputs: frozenInputs.map((input) => ({ id: input.id, displayName: input.displayName, sha256: input.sha256 })) }, source: 'control_plane' });
    }
    const [, changed] = await this.dataSource.query(`UPDATE tasks SET state='planning', updated_at=now() WHERE id=$1 AND state='received'`, [taskId]);
    if (!changed) return { taskId, state: String((await this.getTask(taskId)).state) };
    this.orchestration.enqueue(taskId);
    return { taskId, state: 'planning' };
  }

  private readonly stops = new Map<string, Promise<{ state: 'cancelled' }>>();

  public stopTask(taskId: string): Promise<{ state: 'cancelled' }> {
    const pending = this.stops.get(taskId);
    if (pending) return pending;
    const operation = this.stop(taskId).finally(() => this.stops.delete(taskId));
    this.stops.set(taskId, operation);
    return operation;
  }

  private async stop(taskId: string): Promise<{ state: 'cancelled' }> {
    const [, changed] = await this.dataSource.query(`
      UPDATE tasks SET state='stopping', updated_at=now() WHERE id=$1
      AND state IN ('received','planning','planned','running','awaiting_user_input','awaiting_review')
    `, [taskId]);
    if (!changed) {
      const task = await this.getTask(taskId);
      if (task.state === 'cancelled') return { state: 'cancelled' };
      if (task.state !== 'stopping') throw new ConflictException({ code: 'task_already_finished', message: '任务已经结束。' });
    } else {
      await this.activities.append({ taskId, kind: 'stop_requested', state: 'stopping', message: '管理员已请求停止任务。', source: 'control_plane' });
    }
    this.scheduler.abortAcceptance(taskId);
    const draining=this.orchestration.abort(taskId);
    try {
      await Promise.all([draining,this.scheduler.stopActiveAttempts(taskId)]);
    } catch {
      const message = '节点管理服务未确认全部实例已停止，可重试停止任务。';
      await this.activities.append({ taskId, kind: 'stop_failed', state: 'stopping', message, source: 'control_plane' });
      throw new ConflictException({ code: 'task_stop_pending', message });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query("UPDATE task_nodes SET state='cancelled', updated_at=now() WHERE plan_id IN (SELECT id FROM task_plans WHERE task_id=$1) AND state IN ('pending','leasing','running','awaiting_user_input','interrupted')", [taskId]);
      await manager.query("UPDATE task_interactions SET state='cancelled' WHERE task_id=$1 AND state IN ('pending','answered')", [taskId]);
      await manager.query("UPDATE tasks SET state='cancelled', updated_at=now() WHERE id=$1 AND state='stopping'", [taskId]);
    });
    const message = '管理员已停止任务。';
    await this.sessions.append(taskId, { kind: 'task_cancelled', message });
    await this.sessions.writeStateSnapshot(taskId, { taskId, state: 'cancelled', message });
    await this.activities.append({ taskId, kind: 'task_cancelled', state: 'cancelled', message, source: 'control_plane' });
    return { state: 'cancelled' };
  }

  public async listTasks(): Promise<unknown[]> {
    return this.dataSource.query(`SELECT id, goal, state, acceptance_mode AS "acceptanceMode", created_at AS "createdAt", updated_at AS "updatedAt" FROM tasks ORDER BY created_at DESC LIMIT 50`);
  }

  public async getTaskDetail(taskId: string): Promise<unknown> {
    const task = (await this.dataSource.query<Record<string, unknown>[]>(`SELECT * FROM tasks WHERE id = $1`, [taskId]))[0];
    if (!task) throw new NotFoundException('Task not found.');
    const plans = await this.dataSource.query<Record<string, unknown>[]>(`SELECT * FROM task_plans WHERE task_id=$1 ORDER BY version DESC`, [taskId]);
    const nodes = await this.dataSource.query<Record<string, unknown>[]>(`SELECT n.* FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 ORDER BY n.created_at`, [taskId]);
    // A lease token is an instance credential, never an operator-facing
    // diagnostic field. Explicit columns keep future table changes from
    // accidentally exposing it in the browser response.
    const attempts = await this.dataSource.query<Record<string, unknown>[]>(`SELECT a.id, a.task_node_id, a.instance_id, a.attempt_number, a.lease_expires_at, a.state, a.created_at, a.updated_at, a.unit_name, a.last_heartbeat_at, a.result_received_at FROM task_attempts a JOIN task_nodes n ON n.id=a.task_node_id JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 ORDER BY a.created_at`, [taskId]);
    const events = (await this.dataSource.query<Record<string, unknown>[]>(`SELECT e.* FROM task_events e JOIN task_attempts a ON a.instance_id=e.instance_id JOIN task_nodes n ON n.id=a.task_node_id JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 ORDER BY e.occurred_at, e.sequence`, [taskId])).map((event) => ({ ...event, payload: redactOperatorValue(event.payload) }));
    const activities = await this.activities.listAfter(taskId);
    const artifacts = (await this.artifacts.list(taskId)).map(({ storagePath: _storagePath, ...artifact }) => artifact);
    const inputs = await this.inputs.listForTask(taskId);
    const interactions = await this.interactions.listForTask(taskId);
    const acceptanceRounds=await this.dataSource.query('SELECT id,round,revision_number,criteria,assessment,decision,created_at,decided_at FROM task_acceptance_rounds WHERE task_id=$1 ORDER BY round',[taskId]);
    const revisions=await this.dataSource.query(`SELECT id,revision_number AS "revisionNumber",decision,message,input_ids AS "inputIds",review_id AS "reviewId",
      plan_version AS "planVersion",effective_goal AS "effectiveGoal",previous_delivery AS "previousDelivery",created_at AS "createdAt"
      FROM task_revisions WHERE task_id=$1 ORDER BY revision_number`,[taskId]);
    const latest=acceptanceRounds.filter((r:{revision_number:number})=>r.revision_number===task.revision_number).at(-1);
    const currentReviewId=task.state==='awaiting_review' && latest && !latest.decision ? latest.id : null;
    const delivery = buildTaskDelivery({task,plans,nodes,artifacts,revisions,acceptanceRounds});
    return { delivery, acceptanceRounds, revisions, currentReviewId, task, planSummary: task.planner_summary, plans, nodes, attempts, events, activities, artifacts, inputs, interactions: interactions.map((interaction) => ({ id: interaction.id, taskNodeId: interaction.taskNodeId, planNodeKey: interaction.planNodeKey, source: interaction.source, kind: interaction.kind, title: interaction.title, prompt: interaction.prompt, responseSchema: interaction.responseSchema, responseTarget: interaction.responseTarget, state: interaction.state, answer: interaction.answer, answerMessage: interaction.answerMessage, requestedAt: interaction.requestedAt, answeredAt: interaction.answeredAt, resumedAt: interaction.resumedAt })), workflow: projectWorkflowStages({ task, nodes, attempts, events, interactions }) };
  }

  public async listInteractions(taskId: string) {
    await this.getTask(taskId);
    return this.interactions.listForTask(taskId);
  }

  public async getInteraction(taskId: string, interactionId: string) {
    return this.interactions.get(taskId, interactionId);
  }

  public async respondToInteraction(input: { taskId: string; interactionId: string; response: Record<string, unknown>; message?: string; inputIds?: readonly string[]; idempotencyKey: string }): Promise<{ interactionId: string; state: 'resuming' }> {
    const accepted = await this.interactions.respond({ ...input, actorSubject: 'administrator' });
    await this.scheduler.resumeInteraction(input.taskId, input.interactionId);
    return { interactionId: accepted.interaction.id, state: 'resuming' };
  }

  public async cancelInteraction(taskId: string, interactionId: string): Promise<{ interactionId: string; state: 'cancelled' }> {
    const cancelled = await this.interactions.cancel({ taskId, interactionId, actorSubject: 'administrator' });
    return { interactionId: cancelled.id, state: 'cancelled' };
  }

  public async downloadArtifact(taskId: string, artifactId: string) {
    return this.artifacts.openForDownload(taskId, artifactId);
  }

  public async downloadInput(taskId: string, inputId: string) {
    return this.inputs.openForDownload(taskId, inputId);
  }

  public requestRevision(taskId: string, request: RevisionRequest, key: string|undefined) {
    return requestRevision(taskId,request,key,this.inputs,this.orchestration,this.artifacts);
  }

  public async approveTask(taskId: string): Promise<{ state: 'accepted'; decision: 'accept' }> {
    return this.reviewTask(taskId, 'accept') as Promise<{ state: 'accepted'; decision: 'accept' }>;
  }

  public async reviewTask(taskId: string, decision: 'accept' | 'rework' | 'supplement', reviewId?:string): Promise<{ state: 'accepted' | 'running'; decision: 'accept' | 'rework' | 'supplement' }> {
    if(decision==='supplement') return this.supplementTask(taskId,reviewId);
    if (decision === 'rework') return this.reworkTask(taskId);
    await this.dataSource.transaction(async manager=>{
      const [,changed]=await manager.query("UPDATE tasks SET state='accepted',updated_at=now() WHERE id=$1 AND state='awaiting_review'",[taskId]);
      if(!changed) throw new ConflictException('任务不在待验收状态。');
      const [latest]=await manager.query('SELECT id,decision FROM task_acceptance_rounds WHERE task_id=$1 AND revision_number=(SELECT revision_number FROM tasks WHERE id=$1) ORDER BY round DESC LIMIT 1',[taskId]);
      if((latest?.id??undefined)!==reviewId || latest?.decision) throw new ConflictException('验收轮次已变化，请刷新页面。');
      if(latest) await manager.query("UPDATE task_acceptance_rounds SET decision='accept',decided_at=now() WHERE id=$1",[latest.id]);
    });
    await this.sessions.append(taskId, { kind: 'human_accepted', message: '管理员已确认验收结果。' });
    await this.sessions.writeStateSnapshot(taskId, { taskId, state: 'accepted', message: '管理员已确认验收结果。' });
    await this.activities.append({ taskId, kind: 'human_accepted', state: 'accepted', message: '管理员已确认当前交付。', source: 'control_plane' });
    return { state: 'accepted', decision: 'accept' };
  }

  private async supplementTask(taskId:string,reviewId?:string):Promise<{state:'running';decision:'supplement'}> {
    const round=await this.dataSource.transaction(async manager=>{
      const [task]=await manager.query('SELECT coalesce(effective_goal,goal) AS goal,state,planner_summary FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
      if(!task) throw new NotFoundException('Task not found.');
      const [latest]=await manager.query('SELECT * FROM task_acceptance_rounds WHERE task_id=$1 AND revision_number=(SELECT revision_number FROM tasks WHERE id=$1) ORDER BY round DESC LIMIT 1',[taskId]);
      if(task.state!=='awaiting_review' || !latest || latest.id!==reviewId || latest.decision) throw new ConflictException('验收轮次已变化，请刷新页面。');
      // Keep internal evidence and task-private materials on the knowledge-base route.
      const [scope]=await manager.query(`SELECT
        EXISTS(SELECT 1 FROM task_inputs WHERE task_id=$1) OR
        EXISTS(SELECT 1 FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 AND n.capability IS NOT NULL AND n.capability <> 'research.web')
        AS internal`,[taskId]);
      const capability = scope.internal ? 'knowledge.retrieve' : 'research.web';
      const [agent]=await manager.query(`SELECT agent_id,version FROM agent_versions
        WHERE status='ready' AND manifest->'capabilities' @> $1::jsonb
        AND ($2::boolean OR manifest->'inputSchema'->'properties' ? 'requirements')
        ORDER BY approved_at DESC NULLS LAST,created_at DESC LIMIT 1 FOR SHARE`,[JSON.stringify([{name:capability}]),scope.internal]);
      if(!agent) throw new ConflictException('本任务所需资料范围内没有可用的补查能力。');
      const assessment=latest.assessment;
      const criteria=latest.criteria as Array<{id:string;requirement:string;priority:string}>;
      const requested=assessment.items.filter((i:{status:string})=>i.status!=='met').map((i:{id:string;reason:string})=>{
        const criterion=criteria.find(c=>c.id===i.id);
        return (criterion?.requirement??i.id)+' — '+i.reason;
      });
      const gaps=[...requested,...assessment.reportedGaps];
      if(assessment.error) gaps.push(assessment.error);
      if(!gaps.length) throw new ConflictException('本轮没有待补查项。');
      const previous=await manager.query(`SELECT n.node_key,n.output->'output'->>'summary' AS summary FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 AND n.output->'output' ? 'summary' ORDER BY n.created_at`,[taskId]);
      const requirements=['针对以下缺项补查，结合已交付答复与证据。已有证据沿用并复核时间、地点和来源，不能将本轮当前日期代替任务创建时间。',...gaps.slice(0,12),
        '前次答复：'+[task.planner_summary?.mode==='direct_answer' ? task.planner_summary.summary : '', ...previous.map((n:{summary:string})=>n.summary)].join('\n').slice(-5000),
        '前次证据（编号、来源、摘录）：'+assessment.evidence.slice(-35).map((p:{id:string;source:string;text:string})=>
          [p.id,p.source,p.text.slice(0,400)].join(' ')).join('\n').slice(0,14000)];
      const input=scope.internal ? {query:[task.goal,...requirements].join('\n')} : {query:task.goal.slice(0,5000),requirements,language:'zh-CN'};
      const node={id:'supplement-'+randomUUID(),type:'agent_call',capability,agentId:agent.agent_id,agentVersion:agent.version,
        dependsOn:[],workspace:{mode:'isolated'},input};
      await manager.query("UPDATE task_acceptance_rounds SET decision='supplement',decided_at=now(),supplement_node=$2::jsonb WHERE id=$1",[latest.id,JSON.stringify(node)]);
      await manager.query("UPDATE tasks SET state='planned',updated_at=now() WHERE id=$1",[taskId]);
      return latest.round;
    });
    const message='管理员要求继续补查，已将原需求、前次答复、证据及缺项交给新的研究节点。';
    await this.sessions.append(taskId,{kind:'supplement_requested',message,detail:{round}});
    await this.activities.append({taskId,kind:'supplement_requested',state:'planned',message,detail:{round},source:'control_plane'});
    await this.scheduler.advance(taskId);
    return {state:'running',decision:'supplement'};
  }

  private async reworkTask(taskId: string): Promise<{ state: 'running'; decision: 'rework' }> {
    const task = (await this.dataSource.query<Array<{ id: string; state: string; revision_number:number }>>(`SELECT id, state,revision_number FROM tasks WHERE id=$1`, [taskId]))[0];
    if (!task) throw new NotFoundException('Task not found.');
    if (task.state !== 'awaiting_review') throw new ConflictException('Task is not awaiting a human review decision.');
    const nodes = await this.dataSource.query<Array<Record<string, unknown>>>(`SELECT n.id, n.node_key, n.state, n.input, n.output, n.capability, n.depends_on FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=$1 AND p.version=(SELECT max(version) FROM task_plans WHERE task_id=$1) ORDER BY n.created_at`, [taskId]);
    const quality = nodes.find((node) => text(node.capability) === 'quality.define_and_verify' && qualityFailed(record(node.output)));
    if (!quality) throw new ConflictException('Only a failed quality result may be reworked.');
    const pptKey = strings(quality.depends_on).find((dependency) => nodes.find((node) => text(node.node_key) === dependency && text(node.capability) === 'presentation.create'));
    const ppt = pptKey ? nodes.find((node) => text(node.node_key) === pptKey) : undefined;
    if (!ppt) throw new ConflictException('No reworkable presentation node is linked to the failed quality result.');
    const [pptAttempt, qualityAttempt] = await Promise.all([this.latestAttempt(text(ppt.id)), this.latestAttempt(text(quality.id))]);
    if (!pptAttempt || !qualityAttempt) throw new ConflictException('The failed delivery does not have a retained execution record.');
    const [pptArtifacts, qualityArtifacts] = await Promise.all([this.artifacts.listForAttempt(taskId, pptAttempt.id), this.artifacts.listForAttempt(taskId, qualityAttempt.id)]);
    const previousPresentation = pptArtifacts.find((artifact) => artifact.originalPath === 'presentation.pptx');
    const assessment = qualityArtifacts.find((artifact) => artifact.originalPath === 'quality-assessment.json');
    const criteria = qualityArtifacts.find((artifact) => artifact.originalPath === 'acceptance-criteria.json');
    if (!previousPresentation || !assessment || !criteria) throw new ConflictException('The failed delivery is missing its archived PPT or quality materials.');
    const cycle = pptAttempt.attemptNumber + 1;
    const [pptFile, assessmentFile, criteriaFile] = await Promise.all([
      this.artifacts.openForDownload(taskId, previousPresentation.id), this.artifacts.openForDownload(taskId, assessment.id), this.artifacts.openForDownload(taskId, criteria.id),
    ]);
    const pptNodeKey = text(ppt.node_key);
    await Promise.all([
      this.workspaces.clearNodeReworkOutputs(taskId, pptNodeKey, PPT_REWORK_OUTPUTS,task.revision_number),
      this.workspaces.clearNodeReworkOutputs(taskId, text(quality.node_key), QUALITY_REWORK_OUTPUTS,task.revision_number),
    ]);
    const presentationPath = await this.workspaces.writeNodeReworkInput(taskId, pptNodeKey, `previous-presentation-${cycle}.pptx`, pptFile.content,task.revision_number);
    const assessmentPath = await this.workspaces.writeNodeReworkInput(taskId, pptNodeKey, `previous-quality-assessment-${cycle}.json`, assessmentFile.content,task.revision_number);
    const criteriaPath = await this.workspaces.writeNodeReworkInput(taskId, pptNodeKey, `previous-acceptance-criteria-${cycle}.json`, criteriaFile.content,task.revision_number);
    const failureSummary = qualitySummary(record(quality.output));
    const contextPath = await this.workspaces.writeNodeReworkInput(taskId, pptNodeKey, `retry-context-${cycle}.md`, reworkContext(cycle, failureSummary, presentationPath, assessmentPath, criteriaPath),task.revision_number);
    const plan = await this.currentPlan(taskId);
    const pptInput = reworkInput(plan, pptNodeKey, [presentationPath, assessmentPath, criteriaPath, contextPath]);
    const qualityInput = staticInput(plan, text(quality.node_key));
    await this.workspaces.writeReworkSnapshot(taskId, cycle, { taskId, cycle, decision: 'rework', pptNode: pptNodeKey, qualityNode: text(quality.node_key), sourceAttempt: pptAttempt.attemptNumber, qualityAttempt: qualityAttempt.attemptNumber, failureSummary, inputs: [presentationPath, assessmentPath, criteriaPath, contextPath] },task.revision_number);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE task_nodes SET state='pending', input=$2::jsonb, output=NULL, updated_at=now() WHERE id=$1`, [ppt.id, JSON.stringify(pptInput)]);
      await manager.query(`UPDATE task_nodes SET state='pending', input=$2::jsonb, output=NULL, updated_at=now() WHERE id=$1`, [quality.id, JSON.stringify(qualityInput)]);
      const [, changed] = await manager.query(`UPDATE tasks SET state='planned', updated_at=now() WHERE id=$1 AND state='awaiting_review'`, [taskId]);
      if (!changed) throw new ConflictException('任务状态已更改。');
    });
    await this.sessions.append(taskId, { kind: 'human_rework_requested', message: '管理员已确认根据质检意见返工；上一版交付和验收材料已带入新的 PPT 任务。', detail: { cycle, pptNode: pptNodeKey, qualityNode: text(quality.node_key) } });
    await this.sessions.writeStateSnapshot(taskId, { taskId, state: 'planned', message: '管理员已发起基于质检意见的返工。', reworkCycle: cycle });
    await this.activities.append({ taskId, kind: 'human_rework_requested', state: 'planned', message: '管理员已发起返工，已将上一版交付和质检意见传入 PPT 智能体。', detail: { cycle, nodeKey: pptNodeKey }, source: 'control_plane' });
    await this.scheduler.advance(taskId);
    return { state: 'running', decision: 'rework' };
  }

  private async latestAttempt(nodeId: string): Promise<{ id: string; attemptNumber: number } | undefined> {
    const rows = await this.dataSource.query<Array<{ id: string; attemptNumber: number }>>(`SELECT id, attempt_number AS "attemptNumber" FROM task_attempts WHERE task_node_id=$1 AND state='completed' AND result IS NOT NULL ORDER BY attempt_number DESC LIMIT 1`, [nodeId]);
    return rows[0];
  }

  private async getTask(taskId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
    if (!rows[0]) throw new NotFoundException('Task not found.');
    return rows[0];
  }

  private async currentPlan(taskId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query<Array<{ plan: unknown }>>(`SELECT plan FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 1`, [taskId]);
    if (!rows[0]) throw new ConflictException('Task has no executable plan.');
    return record(rows[0].plan);
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function qualityFailed(output: Record<string, unknown>): boolean { return output.status === 'succeeded' && record(output.output).passed === false; }
function qualitySummary(output: Record<string, unknown>): string { const value = record(output.output); const findings = Array.isArray(value.findings) ? value.findings.map((finding) => text(record(finding).message)).filter(Boolean) : []; return [text(value.summary), ...findings].filter(Boolean).join('；') || '质量验收未通过，请根据验收报告逐项改进。'; }
function staticInput(plan: Record<string, unknown>, nodeKey: string): Record<string, unknown> { const node = Array.isArray(plan.nodes) ? plan.nodes.find((item) => text(record(item).id) === nodeKey) : undefined; if (!node) throw new ConflictException(`Plan node ${nodeKey} is missing.`); return structuredClone(record(record(node).input)); }
function reworkInput(plan: Record<string, unknown>, nodeKey: string, materialPaths: string[]): Record<string, unknown> { const input = staticInput(plan, nodeKey); input.referenceMaterials = [...strings(input.referenceMaterials), ...materialPaths]; return input; }
function reworkContext(cycle: number, summary: string, presentation: string, assessment: string, criteria: string): string { return `# 第 ${cycle} 轮返工上下文\n\n管理员已确认基于上一版交付和质检意见返工。必须先阅读以下任务本地材料，再重新生成 presentation.pptx；不得忽略未通过原因。\n\n- 上一版 PPT：${presentation}\n- 质量验收报告：${assessment}\n- 验收标准：${criteria}\n\n## 必须解决的质检问题\n\n${summary}\n\n新的交付必须保留可追溯资料，并明确无法证实的事实。\n`; }

const PPT_REWORK_OUTPUTS = [
  '.mg-codex-last-message.txt', '.mg-codex-stdout.log', '.mg-codex-stderr.log',
  'presentation.pptx', 'ppt-qa.json', 'qa-notes.md', 'result.json', 'rendered',
] as const;
const QUALITY_REWORK_OUTPUTS = [
  '.mg-codex-last-message.txt', '.mg-codex-stdout.log', '.mg-codex-stderr.log',
  'quality-assessment.json', 'acceptance-criteria.json', 'acceptance-report.md', 'result.json', 'audit',
] as const;
