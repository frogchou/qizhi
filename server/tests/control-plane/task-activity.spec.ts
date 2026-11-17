import { describe, expect, it } from 'vitest';

import { TaskActivityPublisher, TaskActivityService } from '../../apps/control-plane/src/observability/task-activity.service';

type StoredActivity = {
  id: number;
  task_id: string;
  kind: string;
  state: string | null;
  message: string;
  detail: Record<string, unknown>;
  source: string;
  occurred_at: string;
};

class ActivityDataSource {
  public readonly rows: StoredActivity[] = [];

  public async query<T>(sql: string, parameters: unknown[] = []): Promise<T> {
    if (sql.includes('INSERT INTO task_activity_events')) {
      const [taskId, kind, state, message, detail, source] = parameters as [string, string, string | null, string, string, string];
      const row: StoredActivity = {
        id: this.rows.length + 1,
        task_id: taskId,
        kind,
        state,
        message,
        detail: JSON.parse(detail) as Record<string, unknown>,
        source,
        occurred_at: `2026-11-11T10:00:0${this.rows.length}.000Z`,
      };
      this.rows.push(row);
      return [row] as T;
    }
    if (sql.includes('FROM task_activity_events')) {
      const [taskId, afterId] = parameters as [string, number];
      return this.rows.filter((row) => row.task_id === taskId && row.id > afterId) as T;
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

describe('task activity stream', () => {
  it('persists a redacted activity, publishes it and replays only later events in ID order', async () => {
    const dataSource = new ActivityDataSource();
    const publisher = new TaskActivityPublisher();
    const activities = new TaskActivityService(dataSource, publisher);
    const received: string[] = [];
    const unsubscribe = publisher.subscribe('task-438c', (activity) => received.push(activity.message));

    const first = await activities.append({
      taskId: 'task-438c',
      kind: 'planning_started',
      state: 'planning',
      message: '中台开始分析可用能力。',
      detail: { stage: 'catalog', apiKey: 'must-not-persist', nested: { authorization: 'must-not-persist' } },
      source: 'control_plane',
    });
    await activities.append({
      taskId: 'task-438c',
      kind: 'planning_completed',
      state: 'planned',
      message: '已生成可执行图。',
      detail: { nodeCount: 4 },
      source: 'control_plane',
    });
    unsubscribe();

    expect(first).toMatchObject({ id: 1, taskId: 'task-438c', kind: 'planning_started', detail: { stage: 'catalog', apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]' } }});
    expect(received).toEqual(['中台开始分析可用能力。', '已生成可执行图。']);
    await expect(activities.listAfter('task-438c', 1)).resolves.toMatchObject([{ id: 2, kind: 'planning_completed' }]);
  });
});
