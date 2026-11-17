import type { DataSource } from 'typeorm';

import type { TaskActivityInput } from '../observability/task-activity.service.js';
import { OperationalLogger } from '../observability/operational-logger.js';
import type { NodeManagerLauncher } from './task-scheduler.service.js';
import { TaskSchedulerService } from './task-scheduler.service.js';
import { TaskSessionService } from './task-session.service.js';

type ActivityAppender = { append(input: TaskActivityInput): Promise<unknown> };
type LivenessConfig = { startupGraceMs?: number; heartbeatTimeoutMs?: number; sweepIntervalMs?: number };
type ActiveAttempt = {
  attemptId: string;
  taskId: string;
  nodeId: string;
  nodeKey: string;
  instanceId: string;
  attemptNumber: number;
  createdAt: Date | string;
  lastHeartbeatAt: Date | string | null;
};

/**
 * Supervises leased instances independently of browser connections.  A unit
 * name only confirms that systemd accepted a launch request; the first
 * protocol heartbeat confirms that agent code actually booted.  Lost work is
 * retried once, then failed visibly instead of remaining "running" forever.
 */
export class TaskLivenessService {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private readonly startupGraceMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly sweepIntervalMs: number;

  public constructor(
    private readonly dataSource: DataSource,
    private readonly scheduler: TaskSchedulerService,
    private readonly nodeManager: NodeManagerLauncher,
    private readonly sessions: TaskSessionService,
    private readonly activities: ActivityAppender,
    private readonly logger: OperationalLogger = new OperationalLogger(),
    config: LivenessConfig = {},
  ) {
    this.startupGraceMs = config.startupGraceMs ?? 20_000;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 45_000;
    this.sweepIntervalMs = config.sweepIntervalMs ?? 5_000;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.timer.unref();
    void this.sweep();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const attempts = await this.dataSource.query<ActiveAttempt[]>(`
        SELECT a.id AS "attemptId", p.task_id AS "taskId", n.id AS "nodeId", n.node_key AS "nodeKey",
               a.instance_id AS "instanceId", a.attempt_number AS "attemptNumber", a.created_at AS "createdAt",
               a.last_heartbeat_at AS "lastHeartbeatAt"
        FROM task_attempts a
        JOIN task_nodes n ON n.id=a.task_node_id
        JOIN task_plans p ON p.id=n.plan_id
        JOIN tasks t ON t.id=p.task_id
        WHERE a.state='leased' AND n.state='running' AND t.state IN ('planned','running')
      `);
      for (const attempt of attempts) {
        const lastSeen = attempt.lastHeartbeatAt ?? attempt.createdAt;
        const allowed = attempt.lastHeartbeatAt ? this.heartbeatTimeoutMs : this.startupGraceMs;
        if (now - Date.parse(String(lastSeen)) > allowed) await this.handleLostAttempt(attempt, allowed);
      }
    } catch (error) {
      this.logger.error('task_liveness', 'sweep_failed', { detail: { message: publicMessage(error) } });
    } finally {
      this.sweeping = false;
    }
  }

  private async handleLostAttempt(attempt: ActiveAttempt, timeoutMs: number): Promise<void> {
    const marked = await this.dataSource.query<{ id: string }[]>(`
      UPDATE task_attempts SET state='interrupted', updated_at=now()
      WHERE id=$1 AND state='leased'
      RETURNING id
    `, [attempt.attemptId]);
    if (!marked[0]) return;

    try {
      await this.nodeManager.stopInstance(attempt.instanceId);
    } catch (error) {
      this.logger.warn('task_liveness', 'stop_after_liveness_loss_failed', { taskId: attempt.taskId, nodeId: attempt.nodeId, instanceId: attempt.instanceId, detail: { message: publicMessage(error) } });
    }

    const retry = attempt.attemptNumber < 2;
    if (retry) {
      await this.dataSource.query(`UPDATE task_nodes SET state='pending', updated_at=now() WHERE id=$1 AND state='running'`, [attempt.nodeId]);
    } else {
      await this.dataSource.query(`UPDATE task_nodes SET state='failed', output=$2::jsonb, updated_at=now() WHERE id=$1 AND state='running'`, [attempt.nodeId, JSON.stringify({ error: 'agent_liveness_timeout' })]);
    }

    const observed = attempt.lastHeartbeatAt ? '心跳超时' : '启动后未收到首次心跳';
    const message = retry
      ? `中台检测到 ${attempt.nodeKey} ${observed}（超过 ${formatSeconds(timeoutMs)}），已停止旧实例并自动重试一次。`
      : `中台检测到 ${attempt.nodeKey} ${observed}（超过 ${formatSeconds(timeoutMs)}），自动重试次数已用尽，节点已失败。`;
    await this.sessions.append(attempt.taskId, { kind: 'agent_liveness_lost', message, detail: { nodeKey: attempt.nodeKey, instanceId: attempt.instanceId, attemptNumber: attempt.attemptNumber, retry } });
    await this.activities.append({ taskId: attempt.taskId, kind: 'agent_liveness_lost', state: retry ? 'interrupted' : 'failed', message, detail: { nodeKey: attempt.nodeKey, instanceId: attempt.instanceId, attemptNumber: attempt.attemptNumber, retry, timeoutMs, lastHeartbeatAt: attempt.lastHeartbeatAt ?? undefined }, source: 'control_plane' });
    this.logger.warn('task_liveness', 'agent_liveness_lost', { taskId: attempt.taskId, nodeId: attempt.nodeId, instanceId: attempt.instanceId, detail: { nodeKey: attempt.nodeKey, attemptNumber: attempt.attemptNumber, retry, timeoutMs, hadHeartbeat: Boolean(attempt.lastHeartbeatAt) } });
    await this.scheduler.advance(attempt.taskId);
  }
}

function formatSeconds(milliseconds: number): string { return `${Math.max(1, Math.round(milliseconds / 1_000))} 秒`; }
function publicMessage(error: unknown): string { return (error instanceof Error ? error.message : 'unknown error').replace(/\s+/g, ' ').slice(0, 1_000); }
