/** Avoids a live network request: this agent's package has no credential requirement. */
export function performSelfCheck(): { ok: true } {
  if (typeof globalThis.fetch !== 'function') throw new Error('This Node runtime has no fetch implementation.');
  return { ok: true };
}
if (process.argv[1]?.endsWith('self-check.ts')) performSelfCheck();
