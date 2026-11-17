import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { requiredTestDatabaseUrl } from './test-database';

const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
let app: NestFastifyApplication;
const event = { protocolVersion: 'v1', taskId: 'task-1', taskNodeId: 'node-1', instanceId: 'instance-1', leaseToken: 'lease-token-with-at-least-24-characters', sequence: 1, type: 'started', payload: {} };

describe('instance event API', () => {
  beforeAll(async () => {
    await dataSource.initialize(); await dataSource.dropDatabase(); await dataSource.runMigrations();
    await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-1', 'test', 'platform_auto', 'running', '/tmp/task-1')`);
    await dataSource.query(`INSERT INTO task_plans (id, task_id, version, plan, state) VALUES ('plan-1', 'task-1', 1, '{}', 'running')`);
    await dataSource.query(`INSERT INTO task_nodes (id, plan_id, node_key, state) VALUES ('node-1', 'plan-1', 'retrieve', 'running')`);
    await dataSource.query(`INSERT INTO task_attempts (id, task_node_id, instance_id, attempt_number, lease_token, lease_expires_at, state) VALUES ('attempt-1', 'node-1', 'instance-1', 1, $1, now() + interval '5 minutes', 'leased')`, [event.leaseToken]);
    app = await NestFactory.create(AppModule.register({ dataSource, adminTokenHash: '0'.repeat(64), nodeManager: { requestSelfCheck: async () => undefined, syncReadyVersion: async () => undefined } }), new FastifyAdapter()); await app.init();
  });
  afterAll(async () => { if (app) await app.close(); if (dataSource.isInitialized) await dataSource.destroy(); });

  it('rejects wrong leases and duplicate event sequences', async () => {
    const wrongLease = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-1/events', payload: { ...event, leaseToken: 'wrong-lease-token-with-at-least-24-chars' } });
    expect(wrongLease.statusCode).toBe(403);
    const accepted = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-1/events', payload: event });
    expect(accepted.statusCode).toBe(201);
    const lease = await dataSource.query<{ last_heartbeat_at: string | null; lease_expires_at: string }[]>(`SELECT last_heartbeat_at, lease_expires_at FROM task_attempts WHERE id='attempt-1'`);
    expect(lease[0].last_heartbeat_at).not.toBeNull();
    expect(new Date(lease[0].lease_expires_at).getTime()).toBeGreaterThan(Date.now());
    const activity = await dataSource.query<{ kind: string; state: string; source: string }[]>(`SELECT kind, state, source FROM task_activity_events WHERE task_id='task-1'`);
    expect(activity).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent_started', state: 'running', source: 'agent' })]));
    const duplicate = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-1/events', payload: event });
    expect(duplicate.statusCode).toBe(409);
  });

  it('projects Codex heartbeat and bounded runtime output into readable activity events', async () => {
    const heartbeat = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-1/events', payload: { ...event, sequence: 2, type: 'heartbeat', payload: { runtime: 'codex', state: 'running', elapsedMs: 79_000, lastOutputAgeMs: 4_000, outputReceived: true } } });
    const output = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-1/events', payload: { ...event, sequence: 3, type: 'output', payload: { stream: 'stdout', text: 'Codex is drafting the presentation' } } });

    expect(heartbeat.statusCode).toBe(201);
    expect(output.statusCode).toBe(201);
    const activities = await dataSource.query<{ kind: string; message: string }[]>(`SELECT kind, message FROM task_activity_events WHERE task_id='task-1' ORDER BY id`);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'agent_heartbeat', message: expect.stringContaining('Codex 进程仍在运行') }),
      expect.objectContaining({ kind: 'agent_output', message: expect.stringContaining('运行输出') }),
    ]));
  });
});
