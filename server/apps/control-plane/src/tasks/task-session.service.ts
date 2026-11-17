import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';

import { TaskWorkspaceService } from './task-workspace.service.js';

export type TaskSessionEntry = { kind: string; message: string; detail?: Record<string, unknown> };

/** Stores public execution decisions, never credentials, beside the task. */
export class TaskSessionService {
  public constructor(private readonly workspaces: TaskWorkspaceService) {}

  public async append(taskId: string, entry: TaskSessionEntry): Promise<void> {
    rejectSecrets(entry);
    const path = await this.workspaces.resolveTaskPath(taskId, join('session', 'conversation.jsonl'));
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ ...entry, occurredAt: new Date().toISOString() })}\n`, 'utf8');
  }

  public async writeStateSnapshot(taskId: string, snapshot: Record<string, unknown>): Promise<void> {
    rejectSecrets(snapshot);
    const path = await this.workspaces.resolveTaskPath(taskId, 'state.json');
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }
}

function rejectSecrets(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectSecrets(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/(token|secret|password|api_?key)/i.test(key)) throw new Error('Task session/state data must not contain secrets.');
    rejectSecrets(nested);
  }
}
