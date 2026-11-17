import { spawnSync } from 'node:child_process';

/** Configuration-only validation; no target file is examined during approval. */
export function performSelfCheck(command = 'codex'): { ok: true } {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Codex CLI is unavailable for quality-management.');
  return { ok: true };
}
if (process.argv[1]?.endsWith('self-check.ts')) performSelfCheck();
