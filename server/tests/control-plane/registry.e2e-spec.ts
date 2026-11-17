import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { RegistryService } from '../../apps/control-plane/src/registry/registry.service';
import { requiredTestDatabaseUrl } from './test-database';

const token = 'test-administrator-token';
const tokenHash = createHash('sha256').update(token).digest('hex');
const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
const nodeManager = { requestSelfCheck: vi.fn().mockResolvedValue(undefined), syncReadyVersion: vi.fn().mockResolvedValue(undefined) };
let app: NestFastifyApplication;

describe('agent registration API', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    app = await NestFactory.create(AppModule.register({ dataSource, adminTokenHash: tokenHash, nodeManager }), new FastifyAdapter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await dataSource.destroy();
  });

  it('requires the administrator token and discovers a package without executing it', async () => {
    const packagePath = resolve(process.cwd(), 'agents/ragflow-knowledge-v1.0.2');
    const unauthorized = await app.inject({ method: 'POST', url: '/v1/agents/discover', payload: { packagePath } });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({ method: 'POST', url: '/v1/agents/discover', headers: { authorization: `Bearer ${token}` }, payload: { packagePath } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ agentId: 'ragflow-knowledge', version: '1.0.2', status: 'pending_review' });
    const versions = await dataSource.query<{ manifest: { packagePath?: string; inputSchema?: { properties?: Record<string, unknown> }; resultSchema?: { required?: string[] } } }[]>(`SELECT manifest FROM agent_versions WHERE id='ragflow-knowledge@1.0.2'`);
    expect(versions[0].manifest).toMatchObject({ packagePath, inputSchema: { properties: { query: expect.any(Object) } }, resultSchema: { required: expect.arrayContaining(['evidence']) } });
    expect(nodeManager.requestSelfCheck).not.toHaveBeenCalled();
  });

  it('requests a self-check only after explicit approval', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/agents/ragflow-knowledge/versions/1.0.2/approve', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(201);
    expect(nodeManager.requestSelfCheck).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ragflow-knowledge', version: '1.0.2' }));
    expect(nodeManager.syncReadyVersion).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ragflow-knowledge', version: '1.0.2', entryCommand: expect.any(Array) }));
  });

  it('rehydrates the node-manager catalog from reviewed ready versions after a service restart', async () => {
    nodeManager.syncReadyVersion.mockClear();

    await app.get(RegistryService).synchronizeReadyCatalog();

    expect(nodeManager.syncReadyVersion).toHaveBeenCalledTimes(1);
    expect(nodeManager.syncReadyVersion).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ragflow-knowledge', version: '1.0.2', packagePath: resolve(process.cwd(), 'agents/ragflow-knowledge-v1.0.2'), entryCommand: expect.any(Array) }));
  });

  it('returns an incomplete legacy ready record to pending review when its declaration is rediscovered', async () => {
    await dataSource.query(`UPDATE agent_versions SET status='ready', manifest='{}'::jsonb WHERE id='ragflow-knowledge@1.0.2'`);

    const discovered = await app.get(RegistryService).discover(resolve(process.cwd(), 'agents/ragflow-knowledge-v1.0.2'), 'system');
    const rows = await dataSource.query<{ status: string; manifest: { entryCommand?: unknown; inputSchema?: unknown } }[]>(`SELECT status, manifest FROM agent_versions WHERE id='ragflow-knowledge@1.0.2'`);

    expect(discovered.status).toBe('pending_review');
    expect(rows[0]).toMatchObject({ status: 'pending_review', manifest: { entryCommand: expect.any(Array), inputSchema: expect.any(Object) } });
  });

  it('rejects reusing a ready release directory for another version', async () => {
    const packagePath = await mkdtemp(join(tmpdir(), 'agent-release-reuse-'));
    await mkdir(join(packagePath, 'schemas'));
    await writeFile(join(packagePath, 'schemas', 'input.schema.json'), '{"type":"object"}');
    await writeFile(join(packagePath, 'schemas', 'result.schema.json'), '{"type":"object"}');
    await writeFile(join(packagePath, 'agent.yaml'), 'protocolVersion: v1\nagentId: release-isolation\ndisplayName: Release isolation\nversion: 2.0.0\nruntime: native\nentryCommand:\n  - ./run\nselfCheckCommand: ./check\ncapabilities:\n  - name: release.check\n');
    await dataSource.query(`INSERT INTO agents (id, display_name) VALUES ('release-isolation', 'Release isolation')`);
    await dataSource.query(`INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ('release-isolation@1.0.0', 'release-isolation', '1.0.0', 'ready', $1::jsonb)`, [JSON.stringify({ packagePath })]);

    await expect(app.get(RegistryService).discover(packagePath, 'system')).rejects.toThrow('Publish the new version in a new directory');
  });

  it('rejects an incomplete array schema during declaration discovery rather than during task planning', async () => {
    const packagePath = await mkdtemp(join(tmpdir(), 'agent-invalid-schema-'));
    await mkdir(join(packagePath, 'schemas'));
    await writeFile(join(packagePath, 'schemas', 'input.schema.json'), '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}');
    await writeFile(join(packagePath, 'schemas', 'result.schema.json'), '{"type":"object","properties":{"evidence":{"type":"array"}}}');
    await writeFile(join(packagePath, 'agent.yaml'), 'protocolVersion: v1\nagentId: invalid-schema-agent\ndisplayName: Invalid schema\nversion: 1.0.0\nruntime: native\nentryCommand:\n  - ./run\nselfCheckCommand: ./check\ncapabilities:\n  - name: invalid.schema\n');

    await expect(app.get(RegistryService).discover(packagePath, 'system')).rejects.toThrow('array schema requires items');
    await expect(dataSource.query(`SELECT id FROM agent_versions WHERE id='invalid-schema-agent@1.0.0'`)).resolves.toEqual([]);
    await expect(dataSource.query(`SELECT action FROM audit_events WHERE action='agent.pending_schema_quarantined' AND payload->>'agentId'='invalid-schema-agent'`)).resolves.toEqual([]);
  });

  it('quarantines an existing pending version when a later scan finds an invalid declaration', async () => {
    const packagePath = await mkdtemp(join(tmpdir(), 'agent-pending-invalid-schema-'));
    await mkdir(join(packagePath, 'schemas'));
    await writeFile(join(packagePath, 'schemas', 'input.schema.json'), '{"type":"object"}');
    await writeFile(join(packagePath, 'schemas', 'result.schema.json'), '{"type":"object","properties":{"evidence":{"type":"array"}}}');
    await writeFile(join(packagePath, 'agent.yaml'), 'protocolVersion: v1\nagentId: pending-invalid-schema\ndisplayName: Pending invalid schema\nversion: 1.0.0\nruntime: native\nentryCommand:\n  - ./run\nselfCheckCommand: ./check\ncapabilities:\n  - name: pending.invalid\n');
    await dataSource.query(`INSERT INTO agents (id, display_name) VALUES ('pending-invalid-schema', 'Pending invalid schema')`);
    await dataSource.query(`INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ('pending-invalid-schema@1.0.0', 'pending-invalid-schema', '1.0.0', 'pending_review', $1::jsonb)`, [JSON.stringify({ packagePath })]);

    await expect(app.get(RegistryService).discover(packagePath, 'system')).rejects.toThrow('array schema requires items');
    await expect(dataSource.query<{ status: string }[]>(`SELECT status FROM agent_versions WHERE id='pending-invalid-schema@1.0.0'`)).resolves.toEqual([{ status: 'self_check_failed' }]);
  });

  it('refuses to approve a legacy declaration whose reviewed schema is incomplete', async () => {
    await dataSource.query(`INSERT INTO agents (id, display_name) VALUES ('legacy-invalid-schema', 'Legacy invalid schema')`);
    await dataSource.query(`INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ('legacy-invalid-schema@1.0.0', 'legacy-invalid-schema', '1.0.0', 'pending_review', $1::jsonb)`, [JSON.stringify({
      packagePath: '/tmp/legacy-invalid-schema', entryCommand: ['./run'], capabilities: [{ name: 'legacy.invalid' }],
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      resultSchema: { type: 'object', properties: { evidence: { type: 'array' } } },
    })]);

    await expect(app.get(RegistryService).approve('legacy-invalid-schema', '1.0.0')).rejects.toThrow('array schema requires items');
    await expect(dataSource.query<{ status: string }[]>(`SELECT status FROM agent_versions WHERE id='legacy-invalid-schema@1.0.0'`)).resolves.toEqual([{ status: 'pending_review' }]);
  });

  it('quarantines a legacy ready version with an incomplete schema during startup catalog recovery', async () => {
    nodeManager.syncReadyVersion.mockClear();
    await dataSource.query(`INSERT INTO agents (id, display_name) VALUES ('ready-invalid-schema', 'Ready invalid schema')`);
    await dataSource.query(`INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ('ready-invalid-schema@1.0.0', 'ready-invalid-schema', '1.0.0', 'ready', $1::jsonb)`, [JSON.stringify({
      packagePath: '/tmp/ready-invalid-schema', entryCommand: ['./run'], capabilities: [{ name: 'ready.invalid' }],
      inputSchema: { type: 'object' }, resultSchema: { type: 'object', properties: { evidence: { type: 'array' } } },
    })]);

    await app.get(RegistryService).synchronizeReadyCatalog();

    await expect(dataSource.query<{ status: string }[]>(`SELECT status FROM agent_versions WHERE id='ready-invalid-schema@1.0.0'`)).resolves.toEqual([{ status: 'self_check_failed' }]);
    expect(nodeManager.syncReadyVersion).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ready-invalid-schema' }));
  });
});
