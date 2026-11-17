import { describe, expect, it, vi } from 'vitest';

import { OperationalLogger } from '../../apps/control-plane/src/observability/operational-logger';

describe('OperationalLogger', () => {
  it('emits a structured correlated record while redacting secrets from nested detail', () => {
    const write = vi.fn();
    const logger = new OperationalLogger({ write, now: () => new Date('2026-11-11T10:00:00.000Z') });

    logger.error('task_orchestration', 'planning_failed', {
      taskId: 'task-438c',
      detail: { apiKey: 'never-log', nested: { authorization: 'never-log' }, reason: 'Codex exited with code 1' },
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual(expect.objectContaining({
      timestamp: '2026-11-11T10:00:00.000Z',
      level: 'error',
      component: 'task_orchestration',
      event: 'planning_failed',
      taskId: 'task-438c',
      detail: { apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]' }, reason: 'Codex exited with code 1' },
    }));
  });
});
