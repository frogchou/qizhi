import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import type { NodeManagerClient } from './registry.service.js';

type Lifecycle = 'active' | 'deleting' | 'deleted';
type Identity = { lifecycle: Lifecycle; deleted_version_count: number };
type Status = { agentId: string; status: Lifecycle; versionCount: number };

export async function lockedIdentity(db: EntityManager, id: string) {
  const [identity] = await db.query<Identity[]>(
    'SELECT lifecycle,deleted_version_count FROM agents WHERE id=$1 FOR UPDATE',
    [id],
  );
  return identity;
}

const unmetDependency = `
  WITH plans AS (
    SELECT t.id AS task_id,p.id AS plan_id,p.plan FROM tasks t JOIN task_plans p ON p.task_id=t.id
      AND p.version=coalesce(t.current_plan_version,(SELECT max(past.version) FROM task_plans past WHERE past.task_id=t.id))
    WHERE t.state IN ('received','planning','planned','running','awaiting_user_input','awaiting_review','stopping')
  ), definitions AS (
    SELECT p.task_id,p.plan_id,d.definition FROM plans p CROSS JOIN LATERAL
      jsonb_array_elements(CASE WHEN jsonb_typeof(p.plan->'nodes')='array' THEN p.plan->'nodes' ELSE '[]'::jsonb END) d(definition)
    UNION ALL SELECT p.task_id,p.plan_id,r.supplement_node FROM plans p JOIN task_acceptance_rounds r ON r.task_id=p.task_id
      JOIN tasks t ON t.id=p.task_id AND r.revision_number=t.revision_number WHERE r.supplement_node IS NOT NULL
  ), quality AS (
    SELECT p.plan_id,n.agent_id,n.node_key,n.depends_on FROM plans p JOIN task_nodes n ON n.plan_id=p.plan_id
      WHERE n.capability='quality.define_and_verify' AND (n.state NOT IN ('completed','cancelled','failed')
        OR (n.output->>'status'='succeeded' AND (n.output#>'{output,passed}')='false'::jsonb))
    UNION ALL SELECT d.plan_id,d.definition->>'agentId',d.definition->>'id',d.definition->'dependsOn' FROM definitions d
      WHERE d.definition->>'capability'='quality.define_and_verify' AND NOT EXISTS(
        SELECT 1 FROM task_nodes n WHERE n.plan_id=d.plan_id AND n.node_key=d.definition->>'id')
  ), bound AS (
    SELECT p.task_id AS id FROM plans p JOIN task_nodes n ON n.plan_id=p.plan_id WHERE n.agent_id=$1 AND
      (n.state NOT IN ('completed','cancelled','failed') OR
       (n.capability='presentation.create' AND EXISTS(SELECT 1 FROM quality q WHERE q.plan_id=n.plan_id AND q.depends_on ? n.node_key)))
    UNION SELECT d.task_id FROM definitions d WHERE d.definition->>'agentId'=$1 AND NOT EXISTS(
      SELECT 1 FROM task_nodes n WHERE n.plan_id=d.plan_id AND n.node_key=d.definition->>'id')
    UNION SELECT p.task_id FROM plans p JOIN quality q ON q.plan_id=p.plan_id WHERE q.agent_id=$1
    UNION SELECT p.task_id FROM task_attempts j JOIN task_nodes n ON n.id=j.task_node_id
      JOIN task_plans p ON p.id=n.plan_id WHERE j.state IN ('leased','stopping') AND n.agent_id=$1
  )
  SELECT id,count(*) OVER() AS total FROM bound ORDER BY id LIMIT 8`;

export async function identityStatus(db: EntityManager, id: string): Promise<Status> {
  const [row] = await db.query<Array<{ status: Lifecycle; versionCount: number }>>(
    `SELECT a.lifecycle AS status,
    CASE WHEN a.lifecycle='active' THEN (SELECT count(*)::integer FROM agent_versions v WHERE v.agent_id=a.id AND v.status<>'deleted')
      ELSE a.deleted_version_count END AS "versionCount" FROM agents a WHERE a.id=$1`,
    [id],
  );
  if (!row) throw new NotFoundException('未找到该智能体');
  return { agentId: id, ...row };
}

export async function registryAudit(db: EntityManager, actor: string, action: string, payload: object) {
  await db.query('INSERT INTO audit_events(actor,action,payload) VALUES ($1,$2,$3::jsonb)', [
    actor,
    action,
    JSON.stringify(payload),
  ]);
}

/** The first transaction fences planning and discovery. Revocation is retryable across processes and restarts. */
export async function retireAgent(
  db: DataSource,
  nodes: NodeManagerClient,
  agentId: string,
  recovery = false,
): Promise<Status> {
  const begun = await db.transaction(async (manager) => {
    const identity = await lockedIdentity(manager, agentId);
    if (!identity) throw new NotFoundException('未找到该智能体');
    if (identity.lifecycle !== 'active' || recovery) return identityStatus(manager, agentId);
    const versions = await manager.query<Array<{ status: string }>>(
      'SELECT status FROM agent_versions WHERE agent_id=$1 ORDER BY version FOR UPDATE',
      [agentId],
    );
    if (versions.some((row) => row.status === 'self_checking' || row.status === 'draining')) {
      throw new ConflictException({ code: 'agent_busy', message: '智能体的审核或下线正在进行，请完成后重试删除。' });
    }
    const blockers = await manager.query<Array<{ id: string; total: string }>>(unmetDependency, [agentId]);
    if (blockers.length) {
      const taskIds = blockers.map((row) => row.id);
      throw new ConflictException({
        code: 'agent_in_use',
        message: `还有 ${blockers[0].total} 张工单依赖该智能体：${taskIds.join('、')}`,
        taskIds,
        taskCount: Number(blockers[0].total),
      });
    }
    const [, versionCount] = await manager.query(
      "UPDATE agent_versions SET status='deleting' WHERE agent_id=$1 AND status<>'deleted'",
      [agentId],
    );
    await manager.query("UPDATE agents SET lifecycle='deleting', deleted_version_count=$2 WHERE id=$1", [
      agentId,
      versionCount,
    ]);
    await registryAudit(manager, 'admin', 'agent.delete_requested', { agentId, versionCount });
    return { agentId, status: 'deleting' as const, versionCount: Number(versionCount) };
  });
  if (begun.status !== 'deleting') return begun;
  return db.transaction(async (manager) => {
    const identity = await lockedIdentity(manager, agentId);
    if (identity.lifecycle !== 'deleting') return identityStatus(manager, agentId);
    const versions = await manager.query<Array<{ version: string }>>(
      "SELECT version FROM agent_versions WHERE agent_id=$1 AND status='deleting' ORDER BY version",
      [agentId],
    );
    try {
      if (!nodes.revokeVersion) throw new Error('unsupported revoke');
      for (const row of versions) await nodes.revokeVersion(agentId, row.version);
    } catch {
      throw new ServiceUnavailableException({
        code: 'agent_delete_incomplete',
        message: '节点启动权限尚未全部撤销，删除中，可重试。',
      });
    }
    await manager.query("UPDATE agent_versions SET status='deleted' WHERE agent_id=$1 AND status='deleting'", [
      agentId,
    ]);
    await manager.query("UPDATE agents SET lifecycle='deleted',deleted_at=now() WHERE id=$1", [agentId]);
    await registryAudit(manager, recovery ? 'system' : 'admin', 'agent.deleted', {
      agentId,
      versionCount: identity.deleted_version_count,
    });
    return { agentId, status: 'deleted', versionCount: identity.deleted_version_count };
  });
}
