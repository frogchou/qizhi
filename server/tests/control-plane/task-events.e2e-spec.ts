import { createHash } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../apps/control-plane/src/app.module';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source';
import { requiredTestDatabaseUrl } from './test-database';

const token = 'stream-api-administrator-token';
const dataSource = createControlPlaneDataSource(requiredTestDatabaseUrl());
let app: NestFastifyApplication;

describe('task event stream API', () => {
  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await dataSource.runMigrations();
    await dataSource.query(`INSERT INTO tasks (id, goal, acceptance_mode, state, workspace_path) VALUES ('task-stream','stream','platform_auto','planning','/tmp/task-stream')`);
    app = await NestFactory.create(AppModule.register({
      dataSource,
      adminTokenHash: createHash('sha256').update(token).digest('hex'),
      nodeManager: { requestSelfCheck: async () => undefined, syncReadyVersion: async () => undefined, startInstance: async () => ({ instanceId: 'unused', unitName: 'unused' }), stopInstance: async () => undefined } as any,
    }), new FastifyAdapter());
    await app.init();
  });

  afterAll(async () => { await app.close(); await dataSource.destroy(); });

  it('issues a task-scoped ticket only to an authenticated administrator', async () => {
    const denied = await app.inject({ method: 'POST', url: '/v1/tasks/task-stream/events/stream-ticket' });
    expect(denied.statusCode).toBe(401);

    const issued = await app.inject({ method: 'POST', url: '/v1/tasks/task-stream/events/stream-ticket', headers: { authorization: `Bearer ${token}` } });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ ticket: expect.any(String), expiresAt: expect.any(String) });
  });
});
