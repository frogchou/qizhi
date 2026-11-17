import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ReadyCapability } from '../../../../packages/agent-protocol/src/index.js';
import { CONTROL_PLANE_DATA_SOURCE } from '../registry/registry.service.js';
import { toTypeBoxSchema } from './capability-schema.js';

type PersistedManifest = {
  agentId?: string;
  version?: string;
  displayName?: string;
  runtime?: ReadyCapability['runtime'];
  entryCommand?: string[];
  capabilities?: Array<{ name?: string; description?: string }>;
  inputSchema?: unknown;
  resultSchema?: unknown;
};

type ReadyVersionRow = {
  agentId: string;
  version: string;
  displayName: string;
  manifest: PersistedManifest;
};

/**
 * Reads the immutable approval snapshot. A planner never reads agent files from
 * disk: it can only see a reviewed ready version and the schemas approved with it.
 */
@Injectable()
export class CapabilityCatalogService {
  public constructor(@Inject(CONTROL_PLANE_DATA_SOURCE) private readonly dataSource: DataSource) {}

  public async listReady(): Promise<ReadyCapability[]> {
    const rows = await this.dataSource.query<ReadyVersionRow[]>(`
      SELECT DISTINCT ON (v.agent_id)
        v.agent_id AS "agentId", v.version, a.display_name AS "displayName", v.manifest
      FROM agent_versions v
      JOIN agents a ON a.id = v.agent_id
      WHERE v.status = 'ready'
      ORDER BY v.agent_id, v.approved_at DESC NULLS LAST, v.created_at DESC
    `);

    return rows.flatMap((row) => this.capabilitiesFromRow(row));
  }

  private capabilitiesFromRow(row: ReadyVersionRow): ReadyCapability[] {
    const manifest = row.manifest;
    let inputSchema;
    let resultSchema;
    try {
      inputSchema = toTypeBoxSchema(manifest.inputSchema);
      resultSchema = toTypeBoxSchema(manifest.resultSchema);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'schema is invalid';
      throw new Error(`Ready agent ${row.agentId}@${row.version} has an unsupported approved schema: ${message}`);
    }
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
      throw new Error(`Ready agent ${row.agentId}@${row.version} has no approved capabilities.`);
    }

    return manifest.capabilities.map((declaration) => {
      if (!declaration?.name || typeof declaration.name !== 'string') {
        throw new Error(`Ready agent ${row.agentId}@${row.version} has an invalid capability declaration.`);
      }
      return {
        agentId: row.agentId,
        version: row.version,
        displayName: row.displayName,
        runtime: manifest.runtime,
        entryCommand: Array.isArray(manifest.entryCommand) ? manifest.entryCommand : undefined,
        capability: declaration.name,
        description: declaration.description,
        inputSchema,
        resultSchema,
      } satisfies ReadyCapability;
    });
  }
}
