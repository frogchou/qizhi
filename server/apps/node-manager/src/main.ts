import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';

import { NodeManagerModule } from './app.module.js';
import { PackageCatalogService } from './catalog/package-catalog.service.js';

async function main(): Promise<void> {
  const internalTokenHash = process.env.MG_NODE_INTERNAL_TOKEN_HASH;
  if (!internalTokenHash || !/^[a-f0-9]{64}$/i.test(internalTokenHash)) throw new Error('MG_NODE_INTERNAL_TOKEN_HASH must be a SHA-256 hexadecimal hash.');
  const port = Number(process.env.MG_NODE_MANAGER_PORT ?? '3001');
  const catalog = new PackageCatalogService();
  await catalog.load();
  const app = await NestFactory.create(NodeManagerModule.register({ internalTokenHash, catalog }), new FastifyAdapter());
  await app.listen(port, '127.0.0.1');
}

void main();
