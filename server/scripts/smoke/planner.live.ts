import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { CapabilityCatalogService } from '../../apps/control-plane/src/planning/capability-catalog.service.js';
import { CodexPlannerService } from '../../apps/control-plane/src/planning/codex-planner.service.js';
import { createControlPlaneDataSource } from '../../apps/control-plane/src/database/data-source.js';
import { validateTaskPlan } from '../../packages/agent-protocol/src/index.js';
import { CodexCliRunner } from '../../packages/codex-runtime/src/index.js';

const goal = '基于知识库中的栖知相关知识，生成一个栖知产品介绍PPT。';
const workspacePath = process.env.MG_SMOKE_WORKSPACE ?? join('/tmp', `mg-live-planner-${randomUUID()}`);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const dataSource = createControlPlaneDataSource(databaseUrl);
  try {
    await dataSource.initialize();
    const capabilities = await new CapabilityCatalogService(dataSource).listReady();
    const planner = new CodexPlannerService(new CodexCliRunner());
    const task = { id: `smoke-${randomUUID()}`, goal, acceptanceMode: 'platform_auto' };
    let planned;
    let compiled;
    let repair: { reason: string } | undefined;
    let attempts = 0;
    for (attempts = 1; attempts <= 2; attempts += 1) {
      try {
        planned = await planner.plan({ task, capabilities, workspacePath, repair });
        compiled = validateTaskPlan(planned.plan, capabilities);
        break;
      } catch (error) {
        if (attempts === 2) throw error;
        repair = { reason: error instanceof Error ? error.message.slice(0, 1_000) : 'task graph compilation failed' };
      }
    }
    if (!planned || !compiled) throw new Error('Planner did not produce a compiled task graph.');

    console.log(JSON.stringify({
      status: 'compiled',
      attempts,
      workspacePath,
      intent: planned.intent,
      summary: planned.summary,
      capabilities: capabilities.map((item) => ({ capability: item.capability, agentId: item.agentId, version: item.version })),
      nodes: compiled.nodes.map((node) => node.type === 'agent_call' && 'agentId' in node
        ? { id: node.id, type: node.type, capability: node.capability, agentId: node.agentId, agentVersion: node.agentVersion, dependsOn: node.dependsOn ?? [] }
        : { id: node.id, type: node.type, dependsOn: node.dependsOn ?? [] }),
    }, null, 2));
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

void main().catch(() => {
  // The detailed runtime output is persisted under workspacePath by CodexCliRunner.
  // Do not echo the provider stderr here: it can contain the planning prompt.
  console.error(JSON.stringify({ status: 'failed', workspacePath }));
  process.exitCode = 1;
});
