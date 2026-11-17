import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { parse } from 'yaml';

import { AgentManifestSchema } from '../../../packages/agent-protocol/src/index.js';

/** Checks declarations and CLI availability; never opens task materials or runs inference. */
export async function performSelfCheck(command = 'codex'): Promise<{ ok: true }> {
  const packagePath = join(__dirname, '..');
  const manifest = parse(await readFile(join(packagePath, 'agent.yaml'), 'utf8'));
  if (!Value.Check(AgentManifestSchema, manifest)) throw new Error('Invalid Agent Protocol v1 manifest for document-analysis.');
  for (const name of ['input', 'result', 'analysis']) {
    const schema = JSON.parse(await readFile(join(packagePath, 'schemas', `${name}.schema.json`), 'utf8')) as Record<string, unknown>;
    if (schema.type !== 'object' || schema.additionalProperties !== false || !Array.isArray(schema.required) || !schema.properties) throw new Error(`Invalid document-analysis ${name} schema.`);
  }
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Codex CLI is unavailable for document-analysis.');
  return { ok: true };
}

if (process.argv[1]?.endsWith('self-check.ts')) void performSelfCheck();
