import { runTask } from '../../agents/ppt-maker/src/run-task.js';
import { CodexCliRunner } from '../../packages/codex-runtime/src/index.js';

const workspacePath = process.env.MG_SMOKE_WORKSPACE ?? '/home/middleground/data/workspaces/ppt-maker-smoke';

async function main(): Promise<void> {
const result = await runTask({
  protocolVersion: 'v1',
  taskId: 'ppt-maker-smoke',
  taskNodeId: 'ppt-node-1',
  instanceId: 'ppt-instance-1',
  attemptNumber: 1,
  leaseToken: 'lease-token-with-at-least-24-characters',
  workspacePath,
  input: { brief: '制作两页中文项目启动会演示：封面和议程。主题为企业智能体中台。', title: '企业智能体中台项目启动会', slideCount: 2 },
  callback: { url: 'http://127.0.0.1/unused' },
}, { report: async () => undefined }, new CodexCliRunner());

console.log(JSON.stringify({ status: result.status, artifacts: result.artifacts, risks: result.risks, qa: result.output.qa }, null, 2));
}

void main();
