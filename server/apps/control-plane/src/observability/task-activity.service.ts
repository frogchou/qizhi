import type { DataSource } from 'typeorm';

export type TaskActivityInput = {
  taskId: string;
  kind: string;
  state?: string | null;
  message: string;
  detail?: Record<string, unknown>;
  source: 'control_plane' | 'node_manager' | 'agent';
};

export type TaskActivity = {
  id: number;
  taskId: string;
  kind: string;
  state: string | null;
  message: string;
  detail: Record<string, unknown>;
  source: string;
  occurredAt: string;
};

type ActivityRow = {
  id: number | string;
  task_id: string;
  kind: string;
  state: string | null;
  message: string;
  detail: Record<string, unknown> | string;
  source: string;
  occurred_at: Date | string;
};

type Queryable = Pick<DataSource, 'query'>;
type ActivityListener = (activity: TaskActivity) => void;

/** Process-local publisher; database replay remains the authority after disconnects or restarts. */
export class TaskActivityPublisher {
  private readonly listeners = new Map<string, Set<ActivityListener>>();

  public subscribe(taskId: string, listener: ActivityListener): () => void {
    const listeners = this.listeners.get(taskId) ?? new Set<ActivityListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(taskId);
    };
  }

  public publish(activity: TaskActivity): void {
    for (const listener of this.listeners.get(activity.taskId) ?? []) listener(activity);
  }
}

/** Appends redacted activities and makes them available to both SSE and recovery reads. */
export class TaskActivityService {
  public constructor(private readonly dataSource: Queryable, private readonly publisher: TaskActivityPublisher) {}

  public async append(input: TaskActivityInput): Promise<TaskActivity> {
    const rows = await this.dataSource.query<ActivityRow[]>(
      `INSERT INTO task_activity_events (task_id, kind, state, message, detail, source)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       RETURNING id, task_id, kind, state, message, detail, source, occurred_at`,
      [input.taskId, input.kind, input.state ?? null, boundedText(input.message), JSON.stringify(redactOperatorValue(input.detail ?? {})), input.source],
    );
    const activity = mapRow(rows[0]);
    this.publisher.publish(activity);
    return activity;
  }

  public async listAfter(taskId: string, afterId = 0): Promise<TaskActivity[]> {
    const rows = await this.dataSource.query<ActivityRow[]>(
      `SELECT id, task_id, kind, state, message, detail, source, occurred_at
       FROM task_activity_events WHERE task_id=$1 AND id>$2 ORDER BY id ASC`,
      [taskId, afterId],
    );
    return rows.map(mapRow);
  }
}

function mapRow(row: ActivityRow | undefined): TaskActivity {
  if (!row) throw new Error('Task activity insert returned no row.');
  return {
    id: Number(row.id),
    taskId: row.task_id,
    kind: row.kind,
    state: row.state,
    message: row.message,
    detail: typeof row.detail === 'string' ? JSON.parse(row.detail) as Record<string, unknown> : row.detail,
    source: row.source,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

export function redactOperatorValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return boundedText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactOperatorValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, secretKey.test(key) ? '[REDACTED]' : redactOperatorValue(nested, depth + 1)]));
}

const secretKey = /(?:api[_-]?key|authorization|password|secret|token|cookie)/i;

function boundedText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_999)}…`;
}
