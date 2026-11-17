import { loadAgentExecution } from '../../../packages/agent-runtime/src/index.js';
import { RagflowClient } from '../../../packages/ragflow-client/src/index.js';
import { runTask } from './run-task.js';
import { readRagflowAgentConfig } from './self-check.js';

export async function main(): Promise<void> {
  const execution = await loadAgentExecution();
  try {
    const config = readRagflowAgentConfig();
    const client = new RagflowClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    await execution.complete(await runTask(execution.envelope, execution.reporter, client, config.datasetIds));
  } catch (error) {
    await execution.fail(error);
  }
}

if (process.argv[1]?.endsWith('main.ts')) void main();
