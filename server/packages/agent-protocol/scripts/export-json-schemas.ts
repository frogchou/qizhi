import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  AgentEventSchema,
  AgentManifestSchema,
  AgentResultSchema,
  ControlCommandSchema,
  TaskEnvelopeSchema,
  TaskPlanSchema,
} from '../src/schemas.js';

async function main(): Promise<void> {
  const output = resolve(process.cwd(), 'packages/agent-protocol/generated');
  const schemas = {
    'agent-event': AgentEventSchema,
    'agent-manifest': AgentManifestSchema,
    'agent-result': AgentResultSchema,
    'control-command': ControlCommandSchema,
    'task-envelope': TaskEnvelopeSchema,
    'task-plan': TaskPlanSchema,
  };

  await mkdir(output, { recursive: true });
  await Promise.all(Object.entries(schemas).map(([name, schema]) => writeFile(
    resolve(output, `${name}.schema.json`),
    `${JSON.stringify(schema, null, 2)}\n`,
    'utf8',
  )));
}

void main();
