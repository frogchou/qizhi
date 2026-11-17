import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from './app.module.js';
import { loadControlPlaneEnv } from './config/env.js';
import { createControlPlaneDataSource, runMigrations } from './database/data-source.js';
import { HttpNodeManagerClient } from './registry/node-manager.http-client.js';
import { AgentPackageDiscoveryService } from './registry/agent-package-discovery.service.js';
import { RegistryService } from './registry/registry.service.js';
import { OperationalLogger } from './observability/operational-logger.js';
import { TaskRecoveryService } from './tasks/task-recovery.service.js';
import { TaskService } from './tasks/tasks.service.js';
import { TaskLivenessService } from './tasks/task-liveness.service.js';
import { DEFAULT_MAX_TASK_INPUT_FILE_BYTES } from './tasks/task-input.service.js';

async function main(): Promise<void> {
  const env = loadControlPlaneEnv(process.env);
  const dataSource = createControlPlaneDataSource(env.databaseUrl);
  await dataSource.initialize();
  await runMigrations(dataSource);
  const app = await NestFactory.create(AppModule.register({ dataSource, adminTokenHash: env.adminTokenHash, nodeManager: new HttpNodeManagerClient(env.nodeManagerUrl, env.nodeManagerInternalToken), taskRuntime: { ragflowBaseUrl: env.ragflowBaseUrl, ragflowApiKey: process.env.RAGFLOW_API_KEY ?? '', datasetIds: env.ragflowDatasetIds, workspaceRoot: '/home/middleground/data/workspaces', codexPlannerTimeoutMs: env.codexPlannerTimeoutMs, callbackBaseUrl: `http://127.0.0.1:${env.port}`, instanceRuntimeRoot: '/home/middleground/data/runtime/instances', agentPackageRoot: env.agentPackageRoot, taskInputMaxFileBytes: env.taskInputMaxFileBytes, taskInputMaxCount: env.taskInputMaxCount, taskInputMaxTotalBytes: env.taskInputMaxTotalBytes } }), new FastifyAdapter());
  await app.getHttpAdapter().getInstance().register(multipart, { limits: { files: 1, fileSize: env.taskInputMaxFileBytes ?? DEFAULT_MAX_TASK_INPUT_FILE_BYTES, fields: 4, parts: 5, fieldNameSize: 100, fieldSize: 4_096 } });
  const consoleRoot = join(process.cwd(), 'apps', 'console', 'dist');
  if (existsSync(consoleRoot)) {
    await app.getHttpAdapter().getInstance().register(fastifyStatic, { root: consoleRoot, prefix: '/console/' });
  }
  const discovery = app.get(AgentPackageDiscoveryService);
  const logger = app.get(OperationalLogger);
  const discoveryResults = await discovery.discoverAvailable();
  const failedPackages = discoveryResults.filter((result) => result.outcome === 'failed');
  logger.info('agent_discovery', 'scan_completed', { detail: { discovered: discoveryResults.filter(r=>r.outcome==='discovered').length,
    skipped: discoveryResults.filter(r=>r.outcome==='skipped').length, failed: failedPackages.length } });
  for (const result of failedPackages) logger.warn('agent_discovery', 'package_failed', { detail: { packagePath: result.packagePath, reason: result.reason } });
  discovery.startWatching();
  const registry = app.get(RegistryService);
  await registry.recoverVersionChanges();
  await registry.synchronizeReadyCatalog();
  const stopping = await dataSource.query<Array<{ id: string }>>("SELECT id FROM tasks WHERE state='stopping'");
  for (const task of stopping) {
    try { await app.get(TaskService).stopTask(task.id); }
    catch { logger.warn('task_recovery', 'stop_retry_required', { taskId: task.id }); }
  }
  await app.get(TaskRecoveryService).recoverInterrupted();
  app.get(TaskLivenessService).start();
  await app.listen(env.port, '0.0.0.0');
}

void main();
