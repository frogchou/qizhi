import { spawnSync } from 'node:child_process';

/** Configuration-only verification; it does not create a presentation. */
export function performSelfCheck(command = 'codex'): { ok: true } {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Codex CLI is unavailable for ppt-maker.');
  return { ok: true };
}

if (process.argv[1]?.endsWith('self-check.ts')) performSelfCheck();
