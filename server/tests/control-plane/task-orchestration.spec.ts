import { describe, expect, it, vi } from 'vitest';

import { TaskOrchestrationService } from '../../apps/control-plane/src/tasks/task-orchestration.service';

describe('TaskOrchestrationService', () => {
  it('aborts only the addressed planner without scheduling or publishing a failure', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const planning = { createAndCompile: vi.fn(async (_id: string, signal: AbortSignal) => {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }) };
    const activities = { append: vi.fn() };
    const scheduler = { advance: vi.fn() };
    const service = new TaskOrchestrationService({} as any, planning as any, scheduler as any, {} as any, activities as any);
    service.enqueue('stop-me');
    await started;
    await service.abort('stop-me');
    expect(scheduler.advance).not.toHaveBeenCalled();
    expect(activities.append).toHaveBeenCalledTimes(1);
    expect(planning.createAndCompile).toHaveBeenCalledTimes(1);
  });
  it('turns an early planning error into a durable failure and a readable activity instead of leaving planning indefinitely', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'task-stuck' }]);
    const activities = { append: vi.fn().mockResolvedValue(undefined) };
    const sessions = { append: vi.fn().mockResolvedValue(undefined), writeStateSnapshot: vi.fn().mockResolvedValue(undefined) };
    const planning = { createAndCompile: vi.fn().mockRejectedValue(new Error('Codex planner could not start.')) };
    const scheduler = { advance: vi.fn() };
    const service = new TaskOrchestrationService({ query } as any, planning as any, scheduler as any, sessions as any, activities as any);

    await service.run('task-stuck');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE tasks SET state=$2'), ['task-stuck', 'planning_failed']);
    expect(activities.append).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-stuck', kind: 'planning_failed', state: 'planning_failed', message: expect.stringContaining('Codex planner could not start') }));
    expect(sessions.writeStateSnapshot).toHaveBeenCalledWith('task-stuck', expect.objectContaining({ state: 'planning_failed' }));
  });

  it('deduplicates simultaneous enqueue calls for the same task', async () => {
    let complete!: () => void;
    const planning = { createAndCompile: vi.fn(() => new Promise<void>((resolve) => { complete = resolve; })) };
    const service = new TaskOrchestrationService(
      { query: vi.fn() } as any,
      planning as any,
      { advance: vi.fn() } as any,
      { append: vi.fn(), writeStateSnapshot: vi.fn() } as any,
      { append: vi.fn().mockResolvedValue(undefined) } as any,
    );

    service.enqueue('task-once');
    service.enqueue('task-once');
    await Promise.resolve();
    complete();
    await Promise.resolve();

    expect(planning.createAndCompile).toHaveBeenCalledTimes(1);
  });
});
