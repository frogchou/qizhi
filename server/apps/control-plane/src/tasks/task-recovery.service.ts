import type { DataSource } from 'typeorm';

import { TaskSessionService } from './task-session.service.js';
import { TaskOrchestrationService } from './task-orchestration.service.js';
import { TaskSchedulerService } from './task-scheduler.service.js';

/** Restarts only work whose lease was never confirmed by a result callback. */
export class TaskRecoveryService {
  public constructor(private readonly dataSource: DataSource, private readonly scheduler: TaskSchedulerService, private readonly sessions: TaskSessionService, private readonly orchestration?: TaskOrchestrationService) {}

  public async recoverInterrupted(): Promise<void> {
    const interrupted = await this.dataSource.query<{ attemptId: string; nodeId: string; taskId: string }[]>(`
      SELECT a.id AS "attemptId", n.id AS "nodeId", p.task_id AS "taskId"
      FROM task_attempts a JOIN task_nodes n ON n.id=a.task_node_id JOIN task_plans p ON p.id=n.plan_id
      JOIN tasks t ON t.id=p.task_id
      WHERE a.state='leased' AND a.lease_expires_at <= now() AND t.state NOT IN ('stopping','cancelled')
    `);
    for (const item of interrupted) {
      await this.dataSource.query(`UPDATE task_attempts SET state='interrupted', updated_at=now() WHERE id=$1 AND state='leased'`, [item.attemptId]);
      await this.dataSource.query(`UPDATE task_nodes SET state='pending', updated_at=now() WHERE id=$1 AND state IN ('running','leasing')`, [item.nodeId]);
      await this.sessions.append(item.taskId, { kind: 'attempt_interrupted', message: '检测到过期租约，已将节点恢复为待重新调度。' });
    }
    const tasks = await this.dataSource.query<{ id: string }[]>(`SELECT id FROM tasks WHERE state IN ('planned','running') ORDER BY created_at`);
    for (const task of tasks) await this.scheduler.advance(task.id);
    const planning = await this.dataSource.query<{ id: string }[]>(`SELECT id FROM tasks WHERE state IN ('received','planning') ORDER BY created_at`);
    for (const task of planning) this.orchestration?.enqueue(task.id);
  }
}
