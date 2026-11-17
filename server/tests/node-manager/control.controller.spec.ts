import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeManagerModule } from '../../apps/node-manager/src/app.module';

const token = 'node-manager-test-token';
let app: NestFastifyApplication;

describe('node-manager internal API', () => {
  beforeAll(async () => { app = await NestFactory.create(NodeManagerModule.register({ internalTokenHash: createHash('sha256').update(token).digest('hex') }), new FastifyAdapter()); await app.init(); });
  afterAll(async () => { await app.close(); });

  it('rejects control requests without the internal token', async () => {
    const response = await app.inject({ method: 'POST', url: '/internal/v1/instances/instance-1/stop' });
    expect(response.statusCode).toBe(401);
  });
});
