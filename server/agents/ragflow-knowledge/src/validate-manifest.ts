import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Value } from '@sinclair/typebox/value';
import { parse } from 'yaml';

import { AgentManifestSchema } from '../../../packages/agent-protocol/src/index.js';

async function main(): Promise<void> {
  const manifestPath = resolve(process.cwd(), process.argv[2] ?? 'agents/ragflow-knowledge/agent.yaml');
  const manifest = parse(await readFile(manifestPath, 'utf8'));
  if (!Value.Check(AgentManifestSchema, manifest)) throw new Error(`Invalid Agent Protocol v1 manifest: ${manifestPath}`);
}

void main();
