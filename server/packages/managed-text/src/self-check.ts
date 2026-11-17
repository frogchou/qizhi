import { execFileSync } from 'node:child_process';
// Invoked only after administrator approval.
execFileSync('codex', ['--version'], { timeout: 10_000, stdio: 'ignore' });
