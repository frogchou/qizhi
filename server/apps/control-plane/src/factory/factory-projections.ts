import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { activity, activityColumns, type ActivityRow } from './factory-changes.js';
import { Conditions, filter, readPage, type FactoryQuery, type Page } from './factory-query.js';
import { automaticPass, qualityProjection } from './factory-quality.js';
import { buildTaskDelivery } from '../tasks/delivery-content.js';

// Tasks created before plan version tracking can still have a persisted latest plan.
export const currentPlan = `p.version=coalesce(t.current_plan_version,(SELECT max(past.version) FROM task_plans past WHERE past.task_id=t.id))`;
export const activelyManaged = "t.state IN ('received','planning','planned','running','awaiting_user_input','awaiting_review','stopping')";

export const sourceRegistry = [
  { id: 'qizhi_desktop', displayName: '栖知桌面', status: 'available' },
  { id: 'console', displayName: '中台控制台', status: 'available' },
  { id: 'api', displayName: '任务 API', status: 'available' },
  { id: 'unknown', displayName: '历史来源未记录', status: 'unknown' },
  { id: 'wechat', displayName: '微信', status: 'not_connected' },
  { id: 'wecom', displayName: '企业微信', status: 'not_connected' },
  { id: 'feishu', displayName: '飞书', status: 'not_connected' },
  { id: 'email', displayName: '邮件', status: 'not_connected' },
  { id: 'business_system', displayName: '业务系统直连', status: 'not_connected' },
];

export async function sources(db: EntityManager, query: FactoryQuery, paging: Page) {
  const counts = await db.query<Array<{ id: string; taskCount: string; lastReceivedAt: Date }>>(`
    SELECT coalesce(source_system,'unknown') AS id,count(*) AS "taskCount",max(created_at) AS "lastReceivedAt" FROM tasks GROUP BY source_system`);
  const registered = new Set(sourceRegistry.map(r => r.id));
  const recorded = counts.filter(row => !registered.has(row.id)).map(row => ({ id: row.id, displayName: row.id, status: 'observed' }));
  const selected = filter(query, 'sourceSystem');
  const all = [...sourceRegistry, ...recorded].filter(row => !selected || row.id === selected).map(row => {
    const matching = counts.find(item => item.id === row.id);
    return { ...row, taskCount: Number(matching?.taskCount ?? 0), lastReceivedAt: matching?.lastReceivedAt ?? null };
  });
  return { items: all.slice(paging.offset, paging.offset + paging.limit), total: all.length, ...paging, observedAt: new Date().toISOString() };
}

export function tasks(db: EntityManager, query: FactoryQuery, paging: Page) {
  const c = new Conditions();
  c.equals('t.id',filter(query,'taskId'));
  c.equals('t.state',filter(query,'state'));
  c.equals("coalesce(t.source_system,'unknown')",filter(query,'sourceSystem'));
  const area = filter(query,'area');
  if (area === 'control') c.terms.push(activelyManaged);
  else if (area === 'line') c.terms.push(`t.state IN ('planned','running','awaiting_user_input','stopping') AND
    EXISTS(SELECT 1 FROM task_plans p JOIN task_nodes n ON n.plan_id=p.id
    WHERE p.task_id=t.id AND ${currentPlan} AND n.state='running')`);
  else if (area && area !== 'intake') throw new BadRequestException('Unknown task area.');
  const agent = filter(query,'agentId');
  const version = filter(query,'version');
  if (agent || version) {
    const conditions = ['p.task_id=t.id'];
    if (agent) conditions.push('n.agent_id=' + c.bind(agent));
    if (version) conditions.push('n.agent_version=' + c.bind(version));
    c.terms.push('EXISTS(SELECT 1 FROM task_plans p JOIN task_nodes n ON n.plan_id=p.id WHERE ' + conditions.join(' AND ') + ')');
  }
  return readPage(db, `t.id,t.id AS "taskId",t.goal,t.state,t.acceptance_mode AS "acceptanceMode",coalesce(t.source_system,'unknown') AS "sourceSystem",
    t.current_plan_version AS "planVersion",t.planner_summary->>'mode' AS "planMode",t.planner_summary->>'summary' AS "planSummary",
    t.created_at AS "createdAt",t.updated_at AS "updatedAt"`, 'FROM tasks t', 't.created_at DESC,t.id DESC', c, paging);
}

export async function agents(db: EntityManager, query: FactoryQuery, paging: Page) {
  const c = new Conditions();
  c.terms.push("a.lifecycle<>'deleted' AND v.status<>'deleted'");
  c.equals('v.agent_id',filter(query,'agentId'));
  c.equals('v.version',filter(query,'version'));
  const status = filter(query,'status');
  if (status === 'working') c.terms.push('working.count > 0');
  else c.equals('v.status',status);
  const from = `FROM agent_versions v JOIN agents a ON a.id=v.agent_id CROSS JOIN LATERAL (
    SELECT count(*)::integer FROM task_nodes n JOIN task_attempts j ON j.task_node_id=n.id
    WHERE n.agent_id=v.agent_id AND n.agent_version=v.version AND j.state='leased'
  ) working`;
  // Reviewable declaration fields only. Launch commands, schema internals and absolute package paths stay server-side.
  return readPage(db, `v.id,v.agent_id AS "agentId",coalesce(v.manifest->>'displayName',a.display_name) AS "displayName",
    v.version,v.status,v.manifest->>'runtime' AS runtime,v.manifest->>'protocolVersion' AS "protocolVersion",
    v.approved_at AS "approvedAt",v.created_at AS "createdAt",working.count AS "runningCount",
    coalesce((SELECT jsonb_agg(jsonb_build_object('name',cap->>'name','description',cap->>'description') ORDER BY ordinal)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.manifest->'capabilities')='array' THEN v.manifest->'capabilities' ELSE '[]'::jsonb END)
        WITH ORDINALITY AS caps(cap,ordinal) WHERE jsonb_typeof(cap->'name')='string'), '[]'::jsonb) AS capabilities`,
    from, 'a.id,v.created_at DESC,v.id', c, paging);
}

export function quality(db: EntityManager, query: FactoryQuery, paging: Page) {
  const c = new Conditions();
  c.equals('q.id',filter(query,'taskId'));
  const status = filter(query,'status');
  if (status === 'pending_quality') c.terms.push("q.status IN ('pending_review','checking')");
  else if (status === 'failed') c.terms.push("q.verdict='failed'");
  else if (status === 'automatic_passed') c.terms.push(automaticPass);
  else c.equals('q.status',status);
  return readPage(db, 'q.*', 'FROM (' + qualityProjection + ') q', `(q.status='pending_review') DESC,q."updatedAt" DESC,q.id`, c, paging);
}

export async function monitor(db: EntityManager, query: FactoryQuery, paging: Page) {
  const c = new Conditions();
  c.equals('e.task_id',filter(query,'taskId'));
  c.equals('e.kind',filter(query,'kind'));
  c.equals('e.source',filter(query,'source'));
  const result = await readPage<ActivityRow>(db, activityColumns, 'FROM task_activity_events e', 'e.id DESC', c, paging);
  return { ...result, items: result.items.map(activity) };
}

export const activeAttempt = "j.state IN ('leased','stopping')";
export const attemptsFrom = `FROM task_attempts j JOIN task_nodes n ON n.id=j.task_node_id JOIN task_plans p ON p.id=n.plan_id
  JOIN tasks t ON t.id=p.task_id LEFT JOIN agent_versions v ON v.agent_id=n.agent_id AND v.version=n.agent_version`;

export type RuntimeRow = {
  id: string; instanceId: string; taskId: string; goal: string; nodeKey: string; agentId: string; agentVersion: string;
  runtime: string | null; state: string; unitName: string | null; lastHeartbeatAt: Date | null;
  createdAt: Date; updatedAt: Date; attemptNumber: number;
};
export function runtimeJobs(db: EntityManager, query: FactoryQuery, paging: Page) {
  const c = new Conditions();
  c.equals('n.agent_id',filter(query,'agentId'));
  c.equals('n.agent_version',filter(query,'version'));
  c.equals('t.id',filter(query,'taskId'));
  c.equals("v.manifest->>'runtime'",filter(query,'runtime'));
  const state = filter(query,'state');
  if (state === 'active') c.terms.push(activeAttempt);
  else c.equals('j.state',state);
  const columns = `j.id,j.instance_id AS "instanceId",t.id AS "taskId",t.goal,n.node_key AS "nodeKey",n.capability,n.agent_id AS "agentId",
    n.agent_version AS "agentVersion",v.manifest->>'runtime' AS runtime,j.state,j.unit_name AS "unitName",j.last_heartbeat_at AS "lastHeartbeatAt",
    j.created_at AS "createdAt",j.updated_at AS "updatedAt",j.attempt_number AS "attemptNumber"`;
  return readPage<RuntimeRow>(db, columns, attemptsFrom, '(' + activeAttempt + ') DESC,j.created_at DESC,j.id DESC', c, paging);
}

export function runtimeInventory(db: EntityManager) {
  // Codex is also the configured control-plane planner; provider execution is evidenced by its own status events.
  return db.query(`WITH ready AS (
    SELECT manifest->>'runtime' AS runtime,count(*)::integer AS versions FROM agent_versions WHERE status='ready' GROUP BY 1
  ), jobs AS (
    SELECT v.manifest->>'runtime' AS runtime,count(*)::integer AS jobs,count(*) FILTER (WHERE ${activeAttempt})::integer AS active
      ${attemptsFrom} GROUP BY 1
  ), planner AS (
    SELECT count(*)::integer AS n FROM tasks t WHERE t.state='planning' AND EXISTS(
      SELECT 1 FROM task_activity_events e WHERE e.task_id=t.id AND e.kind='planning_codex_status')
  ), runtimes AS (SELECT 'codex' AS runtime UNION SELECT runtime FROM ready UNION SELECT runtime FROM jobs)
    SELECT coalesce(r.runtime,'unknown') AS id, CASE r.runtime WHEN 'codex' THEN 'Codex' WHEN 'native' THEN 'Native' WHEN 'pi' THEN 'Pi'
      ELSE coalesce(r.runtime,'运行时未记录') END AS name,coalesce(ready.versions,0) AS "readyVersionCount",coalesce(jobs.jobs,0) AS "attemptCount",
      coalesce(jobs.active,0) AS "activeCount",CASE WHEN r.runtime='codex' THEN planner.n ELSE 0 END AS "planningCount"
      FROM runtimes r CROSS JOIN planner LEFT JOIN ready ON ready.runtime IS NOT DISTINCT FROM r.runtime
      LEFT JOIN jobs ON jobs.runtime IS NOT DISTINCT FROM r.runtime ORDER BY id`);
}

export async function deliveries(db: EntityManager, query: FactoryQuery, paging: Page) {
  const c = new Conditions();
  c.terms.push("t.state='accepted'");
  c.equals('t.id',filter(query,'taskId'));
  const page = await readPage<{id:string}>(db, `t.id,t.id AS "taskId",t.goal,t.state,t.acceptance_mode AS "acceptanceMode",t.updated_at AS "updatedAt"`,
    'FROM tasks t','t.updated_at DESC,t.id DESC',c,paging);
  if (!page.items.length) return page;
  // Hydrate one page in one database round-trip, then use the exact same
  // projection as task detail and acceptance (never stale assessment summaries).
  const sources = await db.query<Array<{id:string;task:Record<string,unknown>;plans:Record<string,unknown>[];nodes:Record<string,unknown>[];
    artifacts:Record<string,unknown>[];revisions:Record<string,unknown>[];acceptanceRounds:Record<string,unknown>[]}>>(`
    SELECT t.id,to_jsonb(t) AS task,
      coalesce((SELECT jsonb_agg(p ORDER BY p.version) FROM task_plans p WHERE p.task_id=t.id),'[]') AS plans,
      coalesce((SELECT jsonb_agg(n ORDER BY n.created_at,n.id) FROM task_nodes n JOIN task_plans p ON p.id=n.plan_id WHERE p.task_id=t.id),'[]') AS nodes,
      coalesce((SELECT jsonb_agg(f ORDER BY f.created_at,f.id) FROM task_artifacts f WHERE f.task_id=t.id),'[]') AS artifacts,
      coalesce((SELECT jsonb_agg(r ORDER BY r.revision_number) FROM task_revisions r WHERE r.task_id=t.id),'[]') AS revisions,
      coalesce((SELECT jsonb_agg(r ORDER BY r.round) FROM task_acceptance_rounds r WHERE r.task_id=t.id),'[]') AS "acceptanceRounds"
      FROM tasks t WHERE t.id=ANY($1::text[])`, [page.items.map(item=>item.id)]);
  const projected = new Map(sources.map(source=>[source.id,buildTaskDelivery(source)]));
  return {...page,items:page.items.map(item=>{
    const delivery=projected.get(item.id)!;
    return {...item,delivery,artifactCount:delivery.artifactIds.length,supportingArtifactCount:delivery.supportingArtifactIds.length,
      answer:delivery.answers.map(answer=>answer.body).join('\n\n') || null};
  })};
}
