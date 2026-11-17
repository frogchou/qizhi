import { ConflictException, ForbiddenException, Injectable, BadRequestException, Inject } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import { AgentEventSchema, type AgentEvent } from '../../../../packages/agent-protocol/src/index.js';
import { TaskActivityService } from '../observability/task-activity.service.js';
import { OperationalLogger } from '../observability/operational-logger.js';
import { CONTROL_PLANE_DATA_SOURCE } from '../registry/registry.service.js';

@Injectable()
export class InstanceEventsService {
  public constructor(
    @Inject(CONTROL_PLANE_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(TaskActivityService) private readonly activities: TaskActivityService,
    @Inject(OperationalLogger) private readonly logger: OperationalLogger,
  ) {}

  public async append(instanceId: string, input: unknown): Promise<{ accepted: true }> {
    if (!Value.Check(AgentEventSchema, input)) throw new BadRequestException('Event does not match Agent Protocol v1.');
    const event = input as AgentEvent;
    if (event.instanceId !== instanceId) throw new BadRequestException('Event instanceId does not match request path.');
    const attempts = await this.dataSource.query<{ id: string; taskId: string; nodeId: string }[]>(`SELECT a.id, p.task_id AS "taskId", n.id AS "nodeId" FROM task_attempts a JOIN task_nodes n ON n.id=a.task_node_id JOIN task_plans p ON p.id=n.plan_id WHERE a.instance_id = $1 AND a.lease_token = $2 AND a.state = 'leased' AND a.lease_expires_at > now()`, [instanceId, event.leaseToken]);
    if (!attempts[0]) throw new ForbiddenException('Instance does not hold the active lease.');
    try {
      await this.dataSource.query(`INSERT INTO task_events (instance_id, sequence, event_type, payload) VALUES ($1, $2, $3, $4::jsonb)`, [instanceId, event.sequence, event.type, JSON.stringify(event.payload)]);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new ConflictException('Duplicate event sequence for instance.');
      throw error;
    }
    if (event.type === 'checkpoint') await this.dataSource.query(`INSERT INTO task_checkpoints (id, task_attempt_id, checkpoint) VALUES ($1, $2, $3::jsonb)`, [randomUUID(), attempts[0].id, JSON.stringify(event.payload)]);
    await this.dataSource.query(`UPDATE task_attempts SET last_heartbeat_at=now(), lease_expires_at=now() + interval '10 minutes', updated_at=now() WHERE id=$1`, [attempts[0].id]);
    await this.dataSource.query(`INSERT INTO audit_events (actor, action, payload) VALUES ('agent', 'instance.event_accepted', $1::jsonb)`, [JSON.stringify({ instanceId, sequence: event.sequence, type: event.type })]);
    await this.activities.append({
      taskId: attempts[0].taskId,
      kind: `agent_${event.type}`,
      state: event.type === 'failed' ? 'failed' : 'running',
      message: eventMessage(event.type, event.payload),
      detail: { instanceId, nodeId: attempts[0].nodeId, eventType: event.type, sequence: event.sequence, ...event.payload },
      source: 'agent',
    });
    this.logger.info('instance_event', 'accepted', { taskId: attempts[0].taskId, nodeId: attempts[0].nodeId, instanceId, detail: { eventType: event.type, sequence: event.sequence, ...(typeof event.payload.stage === 'string' ? { stage: event.payload.stage } : {}) } });
    return { accepted: true };
  }
}

function eventMessage(type: AgentEvent['type'], payload: Record<string, unknown>): string {
  if (type === 'started') return '智能体进程已启动，开始执行节点。';
  if (type === 'heartbeat' && payload.runtime === 'codex' && (payload.state === 'started' || payload.state === 'running')) return `Codex 进程仍在运行${codexProgress(payload)}。`;
  if (type === 'heartbeat') return '智能体仍在运行，中台已收到心跳。';
  if (type === 'progress') return typeof payload.stage === 'string' ? `智能体正在执行：${payload.stage}。` : '智能体正在执行下一处理阶段。';
  if (type === 'checkpoint') return '智能体已保存阶段性检查点。';
  if (type === 'completed') return '智能体已完成业务处理，正在提交结果。';
  if (type === 'failed') return `智能体报告执行失败：${typeof payload.message === 'string' ? payload.message : '未提供原因'}`;
  if (type === 'output') return `智能体运行输出（${typeof payload.stream === 'string' ? payload.stream : 'stdout'}）。`;
  return '智能体上报新的执行事件。';
}

function codexProgress(payload: Record<string, unknown>): string {
  const details: string[] = [];
  if (typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs) && payload.elapsedMs >= 0) details.push(`，已运行 ${humanDuration(payload.elapsedMs)}`);
  if (typeof payload.lastOutputAgeMs === 'number' && Number.isFinite(payload.lastOutputAgeMs) && payload.lastOutputAgeMs >= 0) details.push(`，最近输出 ${humanDuration(payload.lastOutputAgeMs)}前`);
  else if (payload.outputReceived === false) details.push('，尚未收到输出');
  return details.join('');
}

function humanDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}
