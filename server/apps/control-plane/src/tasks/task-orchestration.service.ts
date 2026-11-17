import type { DataSource } from 'typeorm';

import { TaskActivityService } from '../observability/task-activity.service.js';
import { OperationalLogger } from '../observability/operational-logger.js';
import { PlanningService } from '../planning/planning.service.js';
import { TaskSchedulerService } from './task-scheduler.service.js';
import { TaskSessionService } from './task-session.service.js';

/** Runs one durable planning/scheduling flow per task without holding an HTTP request open. */
export class TaskOrchestrationService {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();

  public async abort(taskId: string): Promise<void> {
    this.controllers.get(taskId)?.abort();
    await this.inFlight.get(taskId);
  }

  public constructor(
    private readonly dataSource: DataSource,
    private readonly planning: PlanningService,
    private readonly scheduler: TaskSchedulerService,
    private readonly sessions: TaskSessionService,
    private readonly activities: TaskActivityService,
    private readonly logger?: OperationalLogger,
  ) {}

  public enqueue(taskId: string): void {
    if (this.inFlight.has(taskId)) return;
    this.logger?.info('task_orchestration', 'task_enqueued', { taskId });
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const operation = this.run(taskId, controller.signal).finally(() => {
      this.inFlight.delete(taskId);
      this.controllers.delete(taskId);
    });
    this.inFlight.set(taskId, operation);
    void operation.catch(() => undefined);
  }

  /** A review can arrive while the preceding delivery is finishing its activity writes. */
  public enqueueRevision(taskId:string, revisionNumber:number): void {
    const previous=this.inFlight.get(taskId);
    if (!previous) { this.enqueue(taskId); return; }
    const resume=async()=>{
      const [ready]=await this.dataSource.query("SELECT id FROM tasks WHERE id=$1 AND revision_number=$2 AND state='planning'",[taskId,revisionNumber]);
      if(ready) this.enqueue(taskId);
    };
    void previous.then(resume,resume).catch(()=>this.logger?.warn('task_orchestration','revision_recovery_required',{taskId}));
  }

  public async run(taskId: string, signal?: AbortSignal): Promise<void> {
    let phase: 'planning' | 'scheduling' = 'planning';
    try {
      await this.activities.append({ taskId, kind: 'planning_started', state: 'planning', message: '中台开始分析需求、已审核能力及执行依赖。', source: 'control_plane' });
      this.logger?.info('task_orchestration', 'planning_started', { taskId });
      const compiled = await this.planning.createAndCompile(taskId, signal);
      if (signal?.aborted) return;
      if (compiled.nodes.every((node) => node.type === 'end')) {
        // Registry answers are already closed. Frozen model-authored answers are planned.
        await this.scheduler.advance(taskId);
        return;
      }
      await this.activities.append({ taskId, kind: 'planning_completed', state: 'planned', message: `意图分析完成，已生成 ${compiled.nodes.length} 个执行节点。`, detail: { nodeCount: compiled.nodes.length }, source: 'control_plane' });
      this.logger?.info('task_orchestration', 'planning_completed', { taskId, detail: { nodeCount: compiled.nodes.length } });
      phase = 'scheduling';
      await this.activities.append({ taskId, kind: 'scheduling_started', state: 'planned', message: '中台开始按依赖关系调度智能体。', source: 'control_plane' });
      await this.scheduler.advance(taskId);
    } catch (error) {
      if (signal?.aborted) return;
      const state = phase === 'planning' ? 'planning_failed' : 'failed';
      const message = publicMessage(error);
      const changed = await this.dataSource.query<{ id: string }[]>(`UPDATE tasks SET state=$2, updated_at=now() WHERE id=$1 AND state IN ('received','planning','planned','running') RETURNING id`, [taskId, state]);
      if (changed[0]) {
        await this.sessions.append(taskId, { kind: `${state}_orchestration_error`, message: `${phase === 'planning' ? '意图分析' : '智能体编排'}失败：${message}` });
        await this.sessions.writeStateSnapshot(taskId, { taskId, state, message });
      }
      await this.activities.append({ taskId, kind: state, state, message: `${phase === 'planning' ? '意图分析失败' : '智能体编排失败'}：${message}`, detail: { phase }, source: 'control_plane' });
      this.logger?.error('task_orchestration', phase === 'planning' ? 'planning_failed' : 'scheduling_failed', { taskId, detail: { phase, message } });
    }
  }
}

function publicMessage(error: unknown): string {
  return (error instanceof Error ? error.message : '未知错误').replace(/\s+/g, ' ').slice(0, 1_000);
}
