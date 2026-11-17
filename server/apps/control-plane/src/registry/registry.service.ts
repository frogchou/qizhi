import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { DataSource } from 'typeorm';

import { AgentManifestSchema, type AgentManifest } from '../../../../packages/agent-protocol/src/index.js';
import { OperationalLogger } from '../observability/operational-logger.js';
import { assertSupportedCapabilitySchemas } from '../planning/capability-schema.js';
import { identityStatus, lockedIdentity, registryAudit, retireAgent } from './agent-retirement.js';
import { newer } from './managed-release.js';

export interface NodeManagerClient {
  revokeVersion?(agentId:string, version:string):Promise<void>;
  requestSelfCheck(input: { agentId: string; version: string; packagePath: string }): Promise<void>;
  syncReadyVersion(input: { agentId: string; version: string; packagePath: string; entryCommand: string[] }): Promise<void>;
}

export const CONTROL_PLANE_DATA_SOURCE = Symbol('CONTROL_PLANE_DATA_SOURCE');
export const NODE_MANAGER_CLIENT = Symbol('NODE_MANAGER_CLIENT');

export type DiscoveredAgentVersion = { agentId: string; version: string; status: string; packagePath: string };

@Injectable()
export class RegistryService {
  private readonly changing = new Set<string>();
  public constructor(
    @Inject(CONTROL_PLANE_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(NODE_MANAGER_CLIENT) private readonly nodeManager: NodeManagerClient,
    @Inject(OperationalLogger) private readonly logger: OperationalLogger,
  ) {}

  /** Reads only declaration files; it never imports or starts package code. */
  public async discover(packagePath: string, actor = 'admin', allowRestore = false): Promise<DiscoveredAgentVersion> {
    const manifest = await this.readManifest(packagePath);
    const versionId = `${manifest.agentId}@${manifest.version}`;
    let inputSchema: Record<string, unknown>;
    let resultSchema: Record<string, unknown>;
    try {
      [inputSchema, resultSchema] = await Promise.all([
        this.readJsonSchema(join(packagePath, 'schemas', 'input.schema.json')),
        this.readJsonSchema(join(packagePath, 'schemas', 'result.schema.json')),
      ]);
      assertSupportedCapabilitySchemas(inputSchema, resultSchema);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown schema validation error';
      await this.quarantinePendingDeclaration(versionId, manifest, packagePath, reason);
      throw error;
    }
    const snapshot = { ...manifest, packagePath, inputSchema, resultSchema };
    const result = await this.dataSource.transaction(async manager => {
      await manager.query(`INSERT INTO agents (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [manifest.agentId, manifest.displayName]);
      const { lifecycle } = await lockedIdentity(manager,manifest.agentId);
      const existing = await manager.query<Array<{ status: string; manifest: unknown }>>(`SELECT status, manifest FROM agent_versions WHERE id=$1`, [versionId]);
      const retired = await manager.query<Array<{version:string}>>("SELECT version FROM agent_versions WHERE agent_id=$1 AND status='deleted'",[manifest.agentId]);
      // Frozen historical versions cannot be rebound, including packages rediscovered after a restore.
      const belowRetired = retired.some(row => !newer(manifest.version,row.version));
      const restoring = lifecycle==='deleted' && allowRestore && actor==='admin' && !belowRetired && !existing[0];
      if ((!restoring && lifecycle!=='active') || belowRetired || existing[0]?.status==='deleted') {
        if (actor === 'system') return { agentId:manifest.agentId,version:manifest.version,status:lifecycle==='deleting'?'deleting':'deleted',packagePath };
        throw new ConflictException(lifecycle==='deleting'?'智能体正在删除，可重试完成删除。':'该身份或版本已删除；请使用新建发布高于历史版本的新版本。');
      }
      const pathConflicts = await manager.query<Array<{ version: string; status: string }>>(
        `SELECT version, status FROM agent_versions WHERE agent_id=$1 AND id<>$2 AND status IN ('ready', 'self_checking','deleted') AND manifest->>'packagePath'=$3`,
        [manifest.agentId, versionId, packagePath],
      );
      if (pathConflicts.length > 0 && (!existing[0] || existing[0].status === 'pending_review')) {
        await registryAudit(manager,actor,'agent.release_path_rejected',{agentId:manifest.agentId,version:manifest.version,packagePath,conflicts:pathConflicts});
        return {rejection:`Package path is already assigned to a reviewed version: ${pathConflicts.map((row) => row.version).join(', ')}. Publish the new version in a new directory.`};
      }
      if (restoring) {
        await manager.query("UPDATE agents SET lifecycle='active',deleted_at=NULL,display_name=$2 WHERE id=$1",[manifest.agentId,manifest.displayName]);
        await registryAudit(manager,actor,'agent.restored',{agentId:manifest.agentId,version:manifest.version});
      }
      let status = existing[0]?.status;
      if (!existing[0]) {
        await manager.query(`INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ($1, $2, $3, 'pending_review', $4::jsonb)`, [versionId, manifest.agentId, manifest.version, JSON.stringify(snapshot)]);
        status = 'pending_review';
        await registryAudit(manager,actor,'agent.discovered',{agentId:manifest.agentId,version:manifest.version,packagePath});
      } else if (existing[0].status === 'ready' && !hasReviewedLaunchSnapshot(existing[0].manifest)) {
        await manager.query(`UPDATE agent_versions SET status='pending_review', manifest=$2::jsonb, approved_at=NULL WHERE id=$1`, [versionId, JSON.stringify(snapshot)]);
        status = 'pending_review';
        await registryAudit(manager,'system', 'agent.legacy_ready_record_replaced', { agentId: manifest.agentId, version: manifest.version, packagePath });
      } else if (existing[0].status === 'pending_review' && text(object(existing[0].manifest).packagePath) !== packagePath) {
        await manager.query(`UPDATE agent_versions SET manifest=$2::jsonb WHERE id=$1`, [versionId, JSON.stringify(snapshot)]);
        status = 'pending_review';
        await registryAudit(manager,actor, 'agent.pending_review_snapshot_refreshed', { agentId: manifest.agentId, version: manifest.version, packagePath });
      }
      const discovered = { agentId: manifest.agentId, version: manifest.version, status: status ?? 'pending_review', packagePath };
      this.logger.info('agent_registry', 'package_discovered', { agentId: manifest.agentId, version: manifest.version, detail: { status: discovered.status, packagePath } });
      return discovered;
    });
    if ('rejection' in result) throw new ConflictException(result.rejection);
    return result;
  }

  public async list(includeDeleted=false): Promise<Array<{ agentId: string; displayName: string; version: string; status: string }>> {
    return this.dataSource.query(`SELECT a.id AS "agentId", a.display_name AS "displayName", v.version, v.status FROM agent_versions v JOIN agents a ON a.id = v.agent_id
      WHERE ($1::boolean OR (v.status<>'deleted' AND a.lifecycle<>'deleted')) ORDER BY a.id, v.version`,[includeDeleted]);
  }

  public status(agentId:string) { return identityStatus(this.dataSource.manager,agentId); }
  public deleteAgent(agentId:string) { return retireAgent(this.dataSource,this.nodeManager,agentId); }

  /** Records a declaration-only discovery failure without importing an agent package. */
  public async recordDiscoveryFailure(packagePath: string, reason: string): Promise<void> {
    await this.audit('system', 'agent.discovery_failed', { packagePath, reason: reason.slice(0, 1_000) });
    this.logger.warn('agent_registry', 'package_discovery_failed', { detail: { packagePath, reason } });
  }

  /** Prevents a previously listed package from remaining actionable after its declaration becomes invalid. */
  private async quarantinePendingDeclaration(versionId: string, manifest: AgentManifest, packagePath: string, reason: string): Promise<void> {
    const existing = await this.dataSource.query<Array<{ status: string }>>(`SELECT status FROM agent_versions WHERE id=$1`, [versionId]);
    if (existing[0]?.status !== 'pending_review') return;
    await this.dataSource.query(`UPDATE agent_versions SET status='self_check_failed' WHERE id=$1 AND status='pending_review'`, [versionId]);
    await this.audit('system', 'agent.pending_schema_quarantined', { agentId: manifest.agentId, version: manifest.version, packagePath, reason });
    this.logger.error('agent_registry', 'pending_schema_quarantined', { agentId: manifest.agentId, version: manifest.version, detail: { packagePath, reason } });
  }

  /** Restores reviewed launch records after a node-manager restart without rerunning approval or self-check. */
  public async synchronizeReadyCatalog(): Promise<number> {
    const rows = await this.dataSource.query<Array<{ agentId: string; version: string; manifest: unknown }>>(`SELECT agent_id AS "agentId", version, manifest FROM agent_versions WHERE status='ready' ORDER BY agent_id, version`);
    let synchronized = 0;
    for (const candidate of rows) {
      synchronized += await this.dataSource.transaction(async manager => {
        const identity = await lockedIdentity(manager,candidate.agentId);
        if (identity?.lifecycle !== 'active') return 0;
        const [row] = await manager.query<Array<typeof candidate>>(`SELECT agent_id AS "agentId",version,manifest FROM agent_versions
          WHERE agent_id=$1 AND version=$2 AND status='ready'`, [candidate.agentId,candidate.version]);
        if (!row) return 0;
        const manifest = object(row.manifest);
        try {
          assertSupportedCapabilitySchemas(manifest.inputSchema, manifest.resultSchema);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown schema validation error';
          await manager.query(`UPDATE agent_versions SET status='self_check_failed' WHERE id=$1 AND status='ready'`, [`${row.agentId}@${row.version}`]);
          await registryAudit(manager,'system', 'agent.ready_schema_quarantined', { agentId: row.agentId, version: row.version, reason });
          this.logger.error('agent_registry', 'ready_schema_quarantined', { agentId: row.agentId, version: row.version, detail: { reason } });
          return 0;
        }
        const packagePath = text(manifest.packagePath);
        const entryCommand = arrayOfText(manifest.entryCommand);
        if (!packagePath || entryCommand.length === 0) {
          await registryAudit(manager,'system', 'agent.ready_catalog_skipped', { agentId: row.agentId, version: row.version, reason: 'missing reviewed launch record' });
          return 0;
        }
        await this.nodeManager.syncReadyVersion({ agentId: row.agentId, version: row.version, packagePath, entryCommand });
        return 1;
      });
    }
    return synchronized;
  }

  public approve(agentId: string, version: string): Promise<{ status: 'ready' }> {
    return this.changeVersion(agentId, version, () => this.approveVersion(agentId, version));
  }

  private async approveVersion(agentId: string, version: string): Promise<{ status: 'ready' }> {
    const versionId = `${agentId}@${version}`;
    const rows = await this.dataSource.query<{ manifest: { packagePath?: string; entryCommand?: string[]; inputSchema?: unknown; resultSchema?: unknown }; status: string }[]>(`SELECT manifest, status FROM agent_versions WHERE id = $1`, [versionId]);
    const record = rows[0];
    if (!record) throw new NotFoundException('未找到该智能体版本');
    if (!['pending_review','offline','self_check_failed'].includes(record.status)) throw new ConflictException(`当前状态无法审核：${record.status}`);
    const packagePath = record.manifest.packagePath;
    if (!packagePath) throw new Error('Agent version has no discovered package path.');
    assertSupportedCapabilitySchemas(record.manifest.inputSchema, record.manifest.resultSchema);
    const [,changed] = await this.dataSource.query(`UPDATE agent_versions SET status = 'self_checking', approved_at = now() WHERE id = $1 AND status=$2`, [versionId,record.status]);
    if(!changed) throw new ConflictException('此版本正在由其他操作处理');
    this.logger.info('agent_registry', 'agent_approval_started', { agentId, version });
    try {
      await this.nodeManager.requestSelfCheck({ agentId, version, packagePath });
      if (!record.manifest.entryCommand?.length) throw new Error('Agent version has no reviewed entry command.');
      await this.nodeManager.syncReadyVersion({ agentId, version, packagePath, entryCommand: record.manifest.entryCommand });
      await this.confirmSelfCheck(agentId, version, true);
      await this.audit('admin', 'agent.approved_for_self_check', { agentId, version });
      this.logger.info('agent_registry', 'agent_ready', { agentId, version });
      return { status: 'ready' };
    } catch (error) {
      await this.confirmSelfCheck(agentId, version, false);
      this.logger.error('agent_registry', 'agent_self_check_failed', { agentId, version, detail: { message: error instanceof Error ? error.message : 'unknown error' } });
      throw error;
    }
  }

  public async confirmSelfCheck(agentId: string, version: string, succeeded: boolean): Promise<void> {
    await this.dataSource.query(`UPDATE agent_versions SET status = $1 WHERE id = $2 AND status = 'self_checking'`, [succeeded ? 'ready' : 'self_check_failed', `${agentId}@${version}`]);
    await this.audit('node-manager', 'agent.self_check_finished', { agentId, version, succeeded });
  }

  /** Stops future launches; existing leased work may finish. Retrying completes any interrupted node-catalog revoke. */
  public offline(agentId: string, version: string) {
    return this.changeVersion(agentId, version, async () => {
      if (!this.nodeManager.revokeVersion) throw new ServiceUnavailableException('节点管理服务未支持版本下线');
      const key = `${agentId}@${version}`;
      const [record] = await this.dataSource.query('SELECT status FROM agent_versions WHERE id=$1', [key]);
      if (!record) throw new NotFoundException('未找到该智能体版本');
      const result = { agentId, version, status: 'offline' };
      if (record.status === 'offline') return result;
      const [, count] = await this.dataSource.query("UPDATE agent_versions SET status='draining' WHERE id=$1 AND status IN ('ready','draining')", [key]);
      if (!count) throw new ConflictException('只有已就绪或正在下线的版本可下线');
      await this.nodeManager.revokeVersion(agentId, version);
      await this.dataSource.query("UPDATE agent_versions SET status='offline' WHERE id=$1 AND status='draining'", [key]);
      await this.audit('admin', 'agent.offline', { agentId, version });
      return result;
    });
  }

  /** The database state prevents new leases while the single control plane synchronizes the launch catalog. */
  private async changeVersion<T>(id: string, version: string, action: () => Promise<T>) {
    const key = `${id}@${version}`;
    if (this.changing.has(key)) throw new ConflictException('该版本正在变更，请稍后刷新');
    this.changing.add(key);
    try { return await action(); }
    finally { this.changing.delete(key); }
  }

  public async recoverVersionChanges() {
    const deleting = await this.dataSource.query<Array<{id:string}>>("SELECT id FROM agents WHERE lifecycle='deleting' ORDER BY id");
    for (const row of deleting) {
      try { await retireAgent(this.dataSource,this.nodeManager,row.id,true); }
      catch (err) {
        if (!(err instanceof ServiceUnavailableException)) throw err;
        this.logger.warn('agent_registry','agent_delete_retry_required',{agentId:row.id});
      }
    }
    const interrupted = await this.dataSource.query("SELECT agent_id, version FROM agent_versions WHERE status='self_checking'");
    for (const row of interrupted) {
      await this.nodeManager.revokeVersion?.(row.agent_id, row.version);
      await this.dataSource.query("UPDATE agent_versions SET status='pending_review' WHERE agent_id=$1 AND version=$2 AND status='self_checking'", [row.agent_id, row.version]);
      await this.audit('system', 'agent.approval_interrupted', { agentId: row.agent_id, version: row.version });
    }
    const retiring = await this.dataSource.query("SELECT agent_id, version FROM agent_versions WHERE status='draining'");
    for (const row of retiring) await this.offline(row.agent_id, row.version);
  }

  private async readManifest(packagePath: string): Promise<AgentManifest> {
    const manifest = parse(await readFile(join(packagePath, 'agent.yaml'), 'utf8'));
    if (!Value.Check(AgentManifestSchema, manifest)) throw new Error('Agent manifest does not match Agent Protocol v1.');
    return manifest;
  }

  private async readJsonSchema(path: string): Promise<Record<string, unknown>> {
    let schema: unknown;
    try {
      schema = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error(`Agent schema ${path} is not valid JSON.`);
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`Agent schema ${path} must be a JSON object.`);
    return schema as Record<string, unknown>;
  }

  private async audit(actor: string, action: string, payload: Record<string, unknown>): Promise<void> {
    await this.dataSource.query(`INSERT INTO audit_events (actor, action, payload) VALUES ($1, $2, $3::jsonb)`, [actor, action, JSON.stringify(payload)]);
  }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function arrayOfText(value: unknown): string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0) ? value : []; }
function hasReviewedLaunchSnapshot(value: unknown): boolean {
  const manifest = object(value);
  return Boolean(text(manifest.packagePath) && arrayOfText(manifest.entryCommand).length && Array.isArray(manifest.capabilities) && isObject(manifest.inputSchema) && isObject(manifest.resultSchema));
}
function isObject(value: unknown): boolean { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
