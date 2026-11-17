import { loadAgentExecution } from '../../../packages/agent-runtime/src/index.js';
import { CodexCliRunner } from '../../../packages/codex-runtime/src/index.js';
import { runTask } from './run-task.js';

async function main() {
  const execution = await loadAgentExecution();
  let result;
  try { result = await runTask(execution.envelope,execution.reporter,new CodexCliRunner()); }
  catch (error) { await execution.fail(error); return; }
  await execution.complete(result);
}
void main();
