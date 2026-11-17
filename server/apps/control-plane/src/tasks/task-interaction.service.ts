import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import type { InteractionCheckpoint, InteractionRequest, TaskResume } from '../../../../packages/agent-protocol/src/index.js';
import type { TaskActivityInput } from '../observability/task-activity.service.js';
import { TaskSessionService } from './task-session.service.js';
import { TaskInputService, type TaskInputSummary } from './task-input.service.js';
import { TaskWorkspaceService } from './task-workspace.service.js';

type ActivityAppender = { append(input: TaskActivityInput): Promise<unknown> };
type Source = 'control_plane' | 'agent';
type InteractionState = 'pending' | 'answered' | 'resumed' | 'cancelled' | 'expired';

export type TaskInteraction = {
  id: string;
  taskId: string;
  taskPlanId?: string;
  taskNodeId?: string;
  planNodeKey: string;
  source: Source;
  kind: InteractionRequest['kind'];
  title: string;
  prompt: string;
  responseSchema: InteractionRequest['responseSchema'];
  responseTarget: string;
  state: InteractionState;
  checkpoint?: InteractionCheckpoint;
  answer?: Record<string, unknown>;
  answerMessage?: string;
  idempotencyKey?: string;
  resumeRound: number;
  requestedAt: string;
  answeredAt?: string;
  resumedAt?: string;
};

type Row = Record<string, unknown>;

/** The single persistence boundary for a task's human questions and replies. */
export class TaskInteractionService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly workspaces: TaskWorkspaceService,
    private readonly sessions: TaskSessionService,
    private readonly activities: ActivityAppender,
    private readonly inputs?: TaskInputService,
  ) {}

  public async requestPlanInteraction(input: { taskId: string; taskPlanId?: string; taskNodeId?: string; planNodeKey: string; request: InteractionRequest; resumeRound?: number }): Promise<TaskInteraction> {
    return this.request({ ...input, source: 'control_plane' });
  }

  public async requestAgentInteraction(input: { taskId: string; taskPlanId?: string; taskNodeId: string; planNodeKey: string; request: InteractionRequest; checkpoint: InteractionCheckpoint; requestedByAttemptId: string; resumeRound?: number }): Promise<TaskInteraction> {
    return this.request({ ...input, source: 'agent' });
  }

  public async pendingForTask(taskId: string): Promise<TaskInteraction[]> {
    const rows = await this.dataSource.query<Row[]>(`SELECT * FROM task_interactions WHERE task_id=$1 AND state='pending' ORDER BY requested_at, id`, [taskId]);
    return rows.map(mapInteraction);
  }

  public async listForTask(taskId: string): Promise<TaskInteraction[]> {
    const rows = await this.dataSource.query<Row[]>(`SELECT * FROM task_interactions WHERE task_id=$1 ORDER BY requested_at, id`, [taskId]);
    return rows.map(mapInteraction);
  }

  public async get(taskId: string, interactionId: string): Promise<TaskInteraction> {
    const rows = await this.dataSource.query<Row[]>(`SELECT * FROM task_interactions WHERE id=$1 AND task_id=$2`, [interactionId, taskId]);
    if (!rows[0]) throw new NotFoundException('Task interaction not found.');
    return mapInteraction(rows[0]);
  }

  public async respond(input: { taskId: string; interactionId: string; response: Record<string, unknown>; message?: string; inputIds?: readonly string[]; idempotencyKey: string; actorSubject?: string }): Promise<{ accepted: true; state: 'answered'; interaction: TaskInteraction; attachments: TaskInputSummary[] }> {
    if (!isIdempotencyKey(input.idempotencyKey)) throw new BadRequestException('Idempotency-Key is invalid.');
    if (input.message !== undefined && (input.message.length > 4_000 || /[\u0000]/.test(input.message))) throw new BadRequestException('Interaction message is invalid.');
    const interaction = await this.get(input.taskId, input.interactionId);
    if (interaction.state !== 'pending') {
      if (interaction.idempotencyKey === input.idempotencyKey && ['answered', 'resumed'].includes(interaction.state)) return { accepted: true, state: 'answered', interaction, attachments: [] };
      throw new ConflictException('Task interaction is no longer awaiting an answer.');
    }
    validateResponse(interaction.responseSchema, input.response);
    const reservation = await this.reserveAnswer({ taskId: input.taskId, interactionId: interaction.id, idempotencyKey: input.idempotencyKey });
    if (reservation === 'already_answered') {
      return { accepted: true, state: 'answered', interaction: await this.get(input.taskId, interaction.id), attachments: [] };
    }
    const attachmentIds = input.inputIds ?? [];
    let attachments: TaskInputSummary[] = [];
    let persisted = false;
    try {
      attachments = attachmentIds.length
        ? await this.requiredInputs().freezeForInteractionAnswer(input.taskId, interaction.id, attachmentIds, input.actorSubject ?? 'administrator')
        : [];
      await this.workspaces.writeInteractionAnswer(input.taskId, interaction.id, { response: input.response, message: input.message ?? null, inputIds: attachments.map((attachment) => attachment.id), answeredAt: new Date().toISOString() });
      const changed = await this.dataSource.transaction(async (manager) => {
        const result = rowsOf(await manager.query(`UPDATE task_interactions SET state='answered', answer=$3::jsonb, answer_message=$4, answered_by_subject=$5, answered_at=now() WHERE id=$1 AND task_id=$2 AND state='pending' AND idempotency_key=$6 RETURNING *`, [interaction.id, input.taskId, JSON.stringify(input.response), input.message ?? null, input.actorSubject ?? 'administrator', input.idempotencyKey]));
        if (!result[0]) return false;
        await manager.query(`INSERT INTO task_interaction_messages (interaction_id, sequence, role, content, structured_content, attachments) VALUES ($1,2,'user',$2,$3::jsonb,$4::jsonb)`, [interaction.id, input.message ?? null, JSON.stringify(input.response), JSON.stringify(attachments.map((attachment) => ({ id: attachment.id, displayName: attachment.displayName, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 })))]);
        return true;
      });
      if (!changed) throw new ConflictException('Task interaction was changed while its answer was being saved.');
      persisted = true;
    } catch (error) {
      if (!persisted) await this.releaseAnswerReservation({ taskId: input.taskId, interactionId: interaction.id, idempotencyKey: input.idempotencyKey });
      throw error;
    }
    const answered = await this.get(input.taskId, interaction.id);
    await this.workspaces.appendInteractionMessage(input.taskId, interaction.id, { role: 'user', content: input.message ?? null, response: input.response, inputIds: attachments.map((attachment) => attachment.id), occurredAt: answered.answeredAt });
    await this.sessions.append(input.taskId, { kind: 'human_interaction_answered', message: `管理员已回答交互问题：${answered.title}。`, detail: { interactionId: answered.id, planNodeKey: answered.planNodeKey, source: answered.source, attachmentCount: attachments.length } });
    await this.activities.append({ taskId: input.taskId, kind: 'human_interaction_answered', state: 'awaiting_user_input', message: `已收到用户回答，等待恢复节点：${answered.planNodeKey}。`, detail: { interactionId: answered.id, planNodeKey: answered.planNodeKey, source: answered.source, attachmentCount: attachments.length }, source: 'control_plane' });
    return { accepted: true, state: 'answered', interaction: answered, attachments };
  }

  public async claimResume(input: { taskId: string; interactionId: string }): Promise<{ claimed: boolean; state: 'resumed'; interaction: TaskInteraction }> {
    const rows = rowsOf(await this.dataSource.query(`UPDATE task_interactions SET state='resumed', resumed_at=now() WHERE id=$1 AND task_id=$2 AND state='answered' RETURNING *`, [input.interactionId, input.taskId]));
    if (rows[0]) return { claimed: true, state: 'resumed', interaction: await this.get(input.taskId, input.interactionId) };
    const interaction = await this.get(input.taskId, input.interactionId);
    if (interaction.state !== 'resumed') throw new ConflictException('Task interaction is not ready to resume.');
    return { claimed: false, state: 'resumed', interaction };
  }

  public async cancel(input: { taskId: string; interactionId: string; actorSubject?: string }): Promise<TaskInteraction> {
    const interaction = await this.get(input.taskId, input.interactionId);
    if (interaction.state !== 'pending') throw new ConflictException('Task interaction is no longer awaiting an answer.');
    const rows = rowsOf(await this.dataSource.query(`UPDATE task_interactions SET state='cancelled' WHERE id=$1 AND task_id=$2 AND state='pending' AND idempotency_key IS NULL RETURNING *`, [input.interactionId, input.taskId]));
    if (!rows[0]) throw new ConflictException('Task interaction was changed by another request.');
    await this.dataSource.query(`UPDATE tasks SET state='cancelled', updated_at=now() WHERE id=$1 AND state='awaiting_user_input'`, [input.taskId]);
    const cancelled = mapInteraction(rows[0]);
    await this.sessions.append(input.taskId, { kind: 'human_interaction_cancelled', message: `管理员已取消交互问题：${cancelled.title}。`, detail: { interactionId: cancelled.id, planNodeKey: cancelled.planNodeKey, source: cancelled.source, actorSubject: input.actorSubject ?? 'administrator' } });
    await this.activities.append({ taskId: input.taskId, kind: 'human_interaction_cancelled', state: 'cancelled', message: `管理员已取消任务等待：${cancelled.title}。`, detail: { interactionId: cancelled.id, planNodeKey: cancelled.planNodeKey, source: cancelled.source }, source: 'control_plane' });
    return cancelled;
  }

  /** Returns only server-persisted data that may be placed in a fresh agent lease. */
  public async resumeContextForNode(input: { taskId: string; taskNodeId: string }): Promise<TaskResume | undefined> {
    const rows = await this.dataSource.query<Row[]>(`
      SELECT * FROM task_interactions
      WHERE task_id=$1 AND task_node_id=$2 AND source='agent' AND state='resumed' AND checkpoint IS NOT NULL
      ORDER BY resumed_at DESC, requested_at DESC LIMIT 1
    `, [input.taskId, input.taskNodeId]);
    if (!rows[0]) return undefined;
    const interaction = mapInteraction(rows[0]);
    if (!interaction.checkpoint || !interaction.answer) throw new ConflictException('Resumed agent interaction is missing its durable checkpoint or answer.');
    return {
      fromInteractionId: interaction.id,
      checkpoint: interaction.checkpoint,
      answers: [{ interactionId: interaction.id, response: interaction.answer }],
    };
  }

  private async request(input: { taskId: string; taskPlanId?: string; taskNodeId?: string; planNodeKey: string; request: InteractionRequest; source: Source; checkpoint?: InteractionCheckpoint; requestedByAttemptId?: string; resumeRound?: number }): Promise<TaskInteraction> {
    const existing = await this.dataSource.query<Row[]>(`SELECT * FROM task_interactions WHERE task_id=$1 AND plan_node_key=$2 AND resume_round=$3 AND state='pending'`, [input.taskId, input.planNodeKey, input.resumeRound ?? 0]);
    if (existing[0]) return mapInteraction(existing[0]);
    const id = randomUUID();
    await this.workspaces.writeInteractionRequest(input.taskId, id, { id, source: input.source, planNodeKey: input.planNodeKey, request: input.request, checkpoint: input.checkpoint ?? null, requestedAt: new Date().toISOString() });
    const rows = await this.dataSource.transaction(async (manager) => {
      const result = rowsOf(await manager.query(`INSERT INTO task_interactions (id, task_id, task_plan_id, task_node_id, plan_node_key, source, kind, title, prompt, response_schema, response_target, state, checkpoint, requested_by_attempt_id, resume_round) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'pending',$12::jsonb,$13,$14) ON CONFLICT DO NOTHING RETURNING *`, [id, input.taskId, input.taskPlanId ?? null, input.taskNodeId ?? null, input.planNodeKey, input.source, input.request.kind, input.request.title, input.request.prompt, JSON.stringify(input.request.responseSchema), input.request.responseTarget, JSON.stringify(input.checkpoint ?? null), input.requestedByAttemptId ?? null, input.resumeRound ?? 0]));
      if (result[0]) {
        await manager.query(`INSERT INTO task_interaction_messages (interaction_id, sequence, role, content, structured_content) VALUES ($1,1,$2,$3,$4::jsonb)`, [id, input.source === 'agent' ? 'agent' : 'control_plane', input.request.prompt, JSON.stringify({ title: input.request.title, kind: input.request.kind })]);
        return result;
      }
      return manager.query<Row[]>(`SELECT * FROM task_interactions WHERE task_id=$1 AND plan_node_key=$2 AND resume_round=$3 AND state='pending'`, [input.taskId, input.planNodeKey, input.resumeRound ?? 0]);
    });
    const interaction = mapInteraction(rows[0]);
    await this.workspaces.appendInteractionMessage(input.taskId, interaction.id, { role: input.source === 'agent' ? 'agent' : 'control_plane', content: input.request.prompt, occurredAt: interaction.requestedAt });
    await this.sessions.append(input.taskId, { kind: 'human_interaction_requested', message: `${input.source === 'agent' ? '智能体' : '中台'}正在等待用户输入：${interaction.title}。`, detail: { interactionId: interaction.id, planNodeKey: interaction.planNodeKey, source: interaction.source } });
    await this.activities.append({ taskId: input.taskId, kind: 'human_interaction_requested', state: 'awaiting_user_input', message: `${input.source === 'agent' ? '智能体' : '中台'}正在等待用户输入：${interaction.title}。`, detail: { interactionId: interaction.id, planNodeKey: interaction.planNodeKey, source: interaction.source }, source: input.source === 'agent' ? 'agent' : 'control_plane' });
    return interaction;
  }

  private requiredInputs(): TaskInputService {
    if (!this.inputs) throw new Error('Task input service is not configured.');
    return this.inputs;
  }

  /** Reserves the only permitted answer writer before any irreversible file or input work begins. */
  private async reserveAnswer(input: { taskId: string; interactionId: string; idempotencyKey: string }): Promise<'reserved' | 'already_answered'> {
    const rows = rowsOf(await this.dataSource.query(`UPDATE task_interactions SET idempotency_key=$3 WHERE id=$1 AND task_id=$2 AND state='pending' AND idempotency_key IS NULL RETURNING *`, [input.interactionId, input.taskId, input.idempotencyKey]));
    if (rows[0]) return 'reserved';
    const current = await this.get(input.taskId, input.interactionId);
    if (current.idempotencyKey === input.idempotencyKey && ['answered', 'resumed'].includes(current.state)) return 'already_answered';
    if (current.state === 'pending' && current.idempotencyKey === input.idempotencyKey) throw new ConflictException('Task interaction answer is already being processed.');
    throw new ConflictException('Task interaction was answered by another request.');
  }

  private async releaseAnswerReservation(input: { taskId: string; interactionId: string; idempotencyKey: string }): Promise<void> {
    await this.dataSource.query(`UPDATE task_interactions SET idempotency_key=NULL WHERE id=$1 AND task_id=$2 AND state='pending' AND idempotency_key=$3`, [input.interactionId, input.taskId, input.idempotencyKey]);
  }
}

function mapInteraction(row: Row): TaskInteraction {
  return {
    id: text(row.id), taskId: text(row.task_id), taskPlanId: optionalText(row.task_plan_id), taskNodeId: optionalText(row.task_node_id), planNodeKey: text(row.plan_node_key), source: text(row.source) as Source, kind: text(row.kind) as InteractionRequest['kind'], title: text(row.title), prompt: text(row.prompt), responseSchema: object(row.response_schema) as InteractionRequest['responseSchema'], responseTarget: text(row.response_target), state: text(row.state) as InteractionState, checkpoint: row.checkpoint ? object(row.checkpoint) as InteractionCheckpoint : undefined, answer: row.answer ? object(row.answer) : undefined, answerMessage: optionalText(row.answer_message), idempotencyKey: optionalText(row.idempotency_key), resumeRound: Number(row.resume_round ?? 0), requestedAt: iso(row.requested_at), answeredAt: row.answered_at ? iso(row.answered_at) : undefined, resumedAt: row.resumed_at ? iso(row.resumed_at) : undefined,
  };
}

function validateResponse(schema: InteractionRequest['responseSchema'], response: Record<string, unknown>): void {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new BadRequestException('Interaction response must be an object.');
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  for (const required of schema.required ?? []) if (!(required in response)) throw new BadRequestException(`Interaction response requires ${required}.`);
  if (schema.additionalProperties === false) for (const key of Object.keys(response)) if (!properties[key]) throw new BadRequestException(`Interaction response contains unexpected field ${key}.`);
  for (const [key, value] of Object.entries(response)) {
    const rule = properties[key];
    if (!rule) continue;
    if (!matchesRule(value, rule)) throw new BadRequestException(`Interaction response field ${key} does not match its schema.`);
  }
}

function matchesRule(value: unknown, rule: Record<string, unknown>): boolean {
  const type = text(rule.type);
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (type === 'array' && !Array.isArray(value)) return false;
  if (typeof value === 'string' && (value.length < number(rule.minLength, 0) || value.length > number(rule.maxLength, 4_000))) return false;
  if (typeof value === 'number' && (value < number(rule.minimum, -Number.MAX_VALUE) || value > number(rule.maximum, Number.MAX_VALUE))) return false;
  if (Array.isArray(value)) {
    if (value.length < number(rule.minItems, 0) || value.length > number(rule.maxItems, 50)) return false;
    const itemType = text(object(rule.items).type);
    if (itemType && value.some((item) => typeof item !== itemType)) return false;
  }
  const allowed = Array.isArray(rule.enum) ? rule.enum : undefined;
  return !allowed || allowed.some((item) => Object.is(item, value));
}

function object(value: unknown): Record<string, unknown> { if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } } return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function optionalText(value: unknown): string | undefined { const result = text(value); return result || undefined; }
function number(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(text(value)).toISOString(); }
function isIdempotencyKey(value: string): boolean { return value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9._-]+$/.test(value); }
function rowsOf(value: unknown): Row[] { return Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Row[] : Array.isArray(value) ? value as Row[] : []; }
