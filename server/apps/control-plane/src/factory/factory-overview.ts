import type { EntityManager } from 'typeorm';
import { activity, activityColumns, type ActivityRow } from './factory-changes.js';
import { activeAttempt, activelyManaged, currentPlan, sourceRegistry } from './factory-projections.js';
import { qualityTotals } from './factory-quality.js';
import type { FactoryDatasets } from './factory-resources.js';

async function counts(db: EntityManager, sql: string): Promise<Record<string, number>> {
  const [row] = await db.query<Record<string, string | number>[]>(sql);
  return Object.fromEntries(Object.entries(row).map(([key,value]) => [key,Number(value)]));
}

export const localAssetCounts = (db: EntityManager) => counts(db,`SELECT
  (SELECT count(*) FROM task_inputs) AS inputs,(SELECT count(*) FROM task_artifacts) AS artifacts,
  (SELECT count(*) FROM tasks WHERE workspace_path <> '') AS sessions`);

export async function overviewFacts(db: EntityManager) {
  const task = await counts(db,`SELECT count(*) AS tasks,count(*) FILTER (WHERE state='received') AS received,
    count(*) FILTER (WHERE state='planning') AS planning,count(*) FILTER (WHERE state='planned') AS planned,
    count(*) FILTER (WHERE ${activelyManaged}) AS "activeTasks",count(*) FILTER (WHERE state='running') AS running,
    count(*) FILTER (WHERE state='awaiting_user_input') AS "awaitingUserInput",count(*) FILTER (WHERE state='awaiting_review') AS "awaitingReview",
    count(*) FILTER (WHERE state='stopping') AS stopping,
    count(*) FILTER (WHERE state='planning_failed') AS "planningFailed",count(*) FILTER (WHERE state IN ('failed','planning_failed')) AS "failedTasks",
    count(*) FILTER (WHERE state='accepted') AS accepted,count(*) FILTER (WHERE source_system IS NULL) AS unknown,
    count(*) FILTER (WHERE source_system='qizhi_desktop') AS "qizhiDesktop",count(*) FILTER (WHERE source_system='api') AS api,
    count(*) FILTER (WHERE source_system='console') AS console FROM tasks t`);
  const versions = await counts(db,`SELECT count(DISTINCT agent_id) AS agents,count(*) FILTER (WHERE status='ready') AS "readyVersions",
    count(*) FILTER (WHERE status='pending_review') AS "pendingReviewVersions",count(*) FILTER (WHERE status='offline') AS "offlineVersions",
    count(DISTINCT manifest->>'runtime') FILTER (WHERE status='ready') AS "readyRuntimes" FROM agent_versions WHERE status<>'deleted'`);
  const line = await counts(db,`SELECT count(*) AS "runningNodes",count(DISTINCT n.agent_id) AS "runningAgents",
    count(DISTINCT t.id) AS "activeTasks",count(*) FILTER (WHERE n.capability='knowledge.retrieve') AS "retrievingNodes"
    FROM task_nodes n JOIN task_plans p ON n.plan_id=p.id JOIN tasks t ON p.task_id=t.id
    WHERE ${currentPlan} AND n.state='running' AND t.state IN ('planned','running','awaiting_user_input','stopping')`);
  const jobs = await counts(db,`SELECT count(*) AS attempts,count(*) FILTER (WHERE ${activeAttempt}) AS active,
    count(*) FILTER (WHERE j.state='leased' AND n.state='running' AND t.state IN ('planned','running') AND
      ((j.last_heartbeat_at IS NULL AND j.created_at < now()-interval '20 seconds') OR j.last_heartbeat_at < now()-interval '45 seconds')) AS "staleInstances"
    FROM task_attempts j JOIN task_nodes n ON n.id=j.task_node_id JOIN task_plans p ON p.id=n.plan_id JOIN tasks t ON t.id=p.task_id`);
  const events = await counts(db,`SELECT count(*) AS events,count(*) FILTER (WHERE kind='agent_heartbeat') AS heartbeats,
    count(*) FILTER (WHERE kind='agent_liveness_lost') AS "livenessLost" FROM task_activity_events`);
  const extra = await counts(db,`SELECT (SELECT count(*) FROM task_plans) AS plans,
    (SELECT count(*) FROM tasks t WHERE t.state='accepted' AND EXISTS(SELECT 1 FROM task_artifacts a WHERE a.task_id=t.id)) AS "withArtifacts",
    (SELECT count(*) FROM task_artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.state='accepted') AS "acceptedArtifacts"`);
  const quality = await counts(db,qualityTotals);
  const assets = await localAssetCounts(db);
  const recent = await db.query<ActivityRow[]>(`SELECT ${activityColumns} FROM task_activity_events e ORDER BY e.id DESC LIMIT 3`);
  return { task, versions, line, jobs, events, extra, quality, assets, recentActivities: recent.map(activity), observedAt: new Date().toISOString() };
}

export function overview(facts: Awaited<ReturnType<typeof overviewFacts>>, connection: Awaited<ReturnType<FactoryDatasets['snapshot']>>['connection'], cursor: string) {
  const { task, versions, line, jobs, events, quality, assets, extra, observedAt, recentActivities } = facts;
  const area = (count: number, summary: string, metrics: Record<string, number>) => ({ count, summary, metrics });
  return { cursor, observedAt, recentActivities, areas: {
    intake: area(task.tasks, `累计接收 ${task.tasks} 张工单`, { tasks: task.tasks, received: task.received,
      channels: sourceRegistry.filter(row => row.status === 'available').length, qizhiDesktop: task.qizhiDesktop, api: task.api, console: task.console, unknown: task.unknown }),
    control: area(task.activeTasks, `${task.activeTasks} 张在办：${task.running} 张执行中，${task.planning} 张规划中。累计 ${task.accepted} 张已验收交付`, {
      activeTasks: task.activeTasks, received: task.received, planning: task.planning, planned: task.planned, running: task.running,
      accepted: task.accepted, awaitingUserInput: task.awaitingUserInput, awaitingReview: task.awaitingReview, stopping: task.stopping,
      planningFailed: task.planningFailed, plans: extra.plans,
      readyVersions: versions.readyVersions, pendingReviewVersions: versions.pendingReviewVersions, offlineVersions: versions.offlineVersions }),
    line: area(line.runningNodes, `${line.runningNodes} 个节点正在执行`, { ...line, agents: versions.agents,
      readyVersions: versions.readyVersions, pendingReviewVersions: versions.pendingReviewVersions }),
    quality: area(quality.pendingReview, `${quality.pendingReview} 张待人工验收，${quality.checking} 张正在核验`, quality),
    assets: { ...area(assets.inputs + assets.artifacts, `${assets.inputs} 份任务资料，${assets.artifacts} 份归档制品`,
      { ...assets, configuredDatasets: connection.configuredCount, ...(connection.visibleCount !== null ? { connectedDatasets: connection.visibleCount } : {}) }), connection },
    runtime: area(jobs.active, `${jobs.active} 个执行实例持有租约或正在停止`, {
      active: jobs.active, attempts: jobs.attempts, readyRuntimes: versions.readyRuntimes, planning: task.planning }),
    monitor: area(jobs.staleInstances, `${jobs.staleInstances} 个实例超过心跳时限`, {
      ...events, failedTasks: task.failedTasks, staleInstances: jobs.staleInstances }),
    delivery: area(task.accepted, `${task.accepted} 张工单已验收，${extra.acceptedArtifacts} 份制品`, {
      accepted: task.accepted, artifacts: extra.acceptedArtifacts, withArtifacts: extra.withArtifacts }),
  } };
}
