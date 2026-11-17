import { BadRequestException } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { redactOperatorValue, type TaskActivity } from '../observability/task-activity.service.js';

export const activityColumns = `e.id, e.task_id AS "taskId", e.kind, e.state, e.message, e.detail, e.source, e.occurred_at AS "occurredAt"`;
export type ActivityRow = Omit<TaskActivity, 'id' | 'occurredAt'> & { id: string; occurredAt: Date };
export function activity(row: ActivityRow): TaskActivity {
  return { ...row, id: Number(row.id), detail: redactOperatorValue(row.detail) as TaskActivity['detail'], occurredAt: row.occurredAt.toISOString() };
}

type Watermarks = { activity: string; audit: string };
type RegistryEvent = { id: string; agentId: string | null; version: string | null; action: string; occurredAt: Date };
const origin = { activity: '0', audit: '0' };
const batchSize = 80;
const watermarkSql = `SELECT COALESCE((SELECT max(id) FROM task_activity_events),0)::text AS activity,
  COALESCE((SELECT max(id) FROM audit_events WHERE action LIKE 'agent.%'),0)::text AS audit`;

export function formatCursor(watermarks: Watermarks): string { return watermarks.activity + '.' + watermarks.audit; }

export function parseCursor(value: unknown): Watermarks {
  if (value === undefined || value === '0') return origin;
  if (typeof value !== 'string' || !/^\d{1,19}\.\d{1,19}$/.test(value)) throw new BadRequestException('Invalid factory cursor.');
  const [a, b] = value.split('.');
  if ([a, b].some(n => BigInt(n) > 9223372036854775807n)) throw new BadRequestException('Invalid factory cursor.');
  return { activity: a, audit: b };
}

/** The two ledgers allocate sequence values before commit. Never checkpoint an exposed but unstable maximum. */
export class FactoryChanges {
  constructor(private readonly db: DataSource) {}

  async watermark(): Promise<Watermarks> {
    const held = await this.acquireFence();
    if (held === null) return origin; // Replaying duplicates is safe when a snapshot races a writer.
    return held;
  }

  private async acquireFence(): Promise<Watermarks | null> {
    try {
      return await this.db.transaction('READ COMMITTED', async manager => {
        // Existing writers finish before a watermark can be safe. NOWAIT never stalls an agent,
        // and the primary-key/partial-index maxima release both locks before snapshot projection.
        await manager.query('LOCK TABLE task_activity_events, audit_events IN SHARE MODE NOWAIT');
        const [result] = await manager.query<Watermarks[]>(watermarkSql);
        return result;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') return null;
      throw error;
    }
  }

  async read(after: Watermarks, waitMs: number, signal?: AbortSignal) {
    const deadline = Date.now() + waitMs;
    // Idle polling performs only two index lookups and holds no connection while waiting.
    while (!signal?.aborted) {
      const [latest] = await this.db.query<Watermarks[]>(watermarkSql);
      if (BigInt(latest.activity) > BigInt(after.activity) || BigInt(latest.audit) > BigInt(after.audit)) {
        const safe = await this.acquireFence();
        if (safe) return this.replay(after, safe);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try { await delay(Math.min(750, remaining), undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
    return { items: [], registryChanges: [], cursor: formatCursor(after), hasMore: false, observedAt: new Date().toISOString() };
  }

  private async replay(after: Watermarks, through: Watermarks) {
    const [events, audit] = await Promise.all([
      this.db.query<ActivityRow[]>(`SELECT ${activityColumns} FROM task_activity_events e
        WHERE e.id > $1 AND e.id <= $2 ORDER BY e.id LIMIT $3`, [after.activity, through.activity, batchSize + 1]),
      this.db.query<RegistryEvent[]>(`SELECT id,action,payload->>'agentId' AS "agentId",payload->>'version' AS version,occurred_at AS "occurredAt"
        FROM audit_events WHERE action LIKE 'agent.%' AND id > $1 AND id <= $2 ORDER BY id LIMIT $3`, [after.audit, through.audit, batchSize + 1]),
    ]);
    const next = {
      activity: events.length > batchSize ? events[batchSize - 1].id : through.activity,
      audit: audit.length > batchSize ? audit[batchSize - 1].id : through.audit,
    };
    return { items: events.slice(0, batchSize).map(activity), registryChanges: audit.slice(0, batchSize),
      cursor: formatCursor(next), hasMore: events.length > batchSize || audit.length > batchSize, observedAt: new Date().toISOString() };
  }
}
