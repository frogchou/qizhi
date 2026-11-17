import { loadAgentExecution } from '../../../packages/agent-runtime/src/index.js';
import { runTask } from './run-task.js';
import { DuckDuckGoSearchProvider } from './search.js';

export async function main(): Promise<void> {
  const execution = await loadAgentExecution();
  try {
    await execution.complete(await runTask(execution.envelope, execution.reporter, new DuckDuckGoSearchProvider()));
  } catch (error) {
    await execution.fail(error);
  }
}

if (process.argv[1]?.endsWith('main.ts')) void main();
