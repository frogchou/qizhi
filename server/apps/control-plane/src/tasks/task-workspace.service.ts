import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';

export type TaskWorkspace = {
  taskId: string;
  root: string;
  plansPath: string;
  sessionPath: string;
  nodesPath: string;
  artifactsPath: string;
  qualityPath: string;
};

export type TaskWorkspaceInput = { id: string; goal: string; acceptanceMode: string };

/** Owns the safe, durable on-disk layout for one control-plane task. */
export class TaskWorkspaceService {
  private readonly root: string;

  public constructor(input: { root: string }) { this.root = resolve(input.root); }

  public async create(task: TaskWorkspaceInput): Promise<TaskWorkspace> {
    const workspace = this.describe(task.id);
    await Promise.all([
      mkdir(workspace.plansPath, { recursive: true }),
      mkdir(workspace.sessionPath, { recursive: true }),
      mkdir(workspace.nodesPath, { recursive: true }),
      mkdir(workspace.artifactsPath, { recursive: true }),
      mkdir(workspace.qualityPath, { recursive: true }),
      mkdir(join(workspace.sessionPath, 'memory'), { recursive: true }),
      mkdir(join(workspace.root, 'interactions'), { recursive: true }),
    ]);
    await this.writeJson(join(workspace.root, 'task.json'), {
      id: task.id,
      goal: task.goal,
      acceptanceMode: task.acceptanceMode,
      createdAt: new Date().toISOString(),
    });
    await this.writeJson(join(workspace.root, 'state.json'), { taskId: task.id, state: 'received', updatedAt: new Date().toISOString() });
    return workspace;
  }

  public taskRoot(taskId: string): string { return this.describe(taskId).root; }

  /** Removes only the freshly-created workspace for an aborted task creation. */
  public async removeTaskWorkspace(taskId: string): Promise<void> {
    await rm(this.taskRoot(taskId), { recursive: true, force: true });
  }

  public async createNodeWorkspace(taskId: string, nodeKey: string, revisionNumber=0): Promise<string> {
    if (!Number.isSafeInteger(revisionNumber)||revisionNumber<0) throw new Error('Invalid task revision number.');
    const root = revisionNumber ? join('revisions',String(revisionNumber),'nodes') : 'nodes';
    const path = await this.resolveTaskPath(taskId, join(root, safeSegment(nodeKey)));
    await mkdir(path, { recursive: true });
    return path;
  }

  /** Creates the immutable parent directory for one archived node-output revision. */
  public async createArtifactRevisionDirectory(taskId: string, nodeId: string, revision: number): Promise<string> {
    if (!Number.isInteger(revision) || revision < 1) throw new Error('Artifact revision must be a positive integer.');
    const path = await this.resolveTaskPath(taskId, join('artifacts', 'nodes', safeSegment(nodeId), `revision-${revision}`));
    await mkdir(path, { recursive: true });
    return path;
  }

  public async writeNodeEnvelope(taskId: string, nodeKey: string, envelope: unknown, revisionNumber=0): Promise<string> {
    const path = join(await this.createNodeWorkspace(taskId, nodeKey, revisionNumber),'envelope.json');
    await this.writeJson(path, envelope);
    return path;
  }

  public async writeInteractionRequest(taskId: string, interactionId: string, request: Record<string, unknown>): Promise<string> {
    const directory = await this.interactionDirectory(taskId, interactionId);
    const path = join(directory, 'request.json');
    await this.writeJson(path, request);
    return path;
  }

  public async appendInteractionMessage(taskId: string, interactionId: string, message: Record<string, unknown>): Promise<string> {
    const directory = await this.interactionDirectory(taskId, interactionId);
    const path = join(directory, 'messages.jsonl');
    await appendFile(path, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600 });
    return path;
  }

  public async writeInteractionAnswer(taskId: string, interactionId: string, answer: Record<string, unknown>): Promise<string> {
    const directory = await this.interactionDirectory(taskId, interactionId);
    const path = join(directory, 'answer.json');
    await this.writeJson(path, answer);
    return path;
  }

  /** Seals verified checkpoint bytes beneath their node, preserving no agent-controlled path. */
  public async writeNodeCheckpoint(taskId: string, nodeKey: string, resumeKey: string, checkpoint: Buffer, revisionNumber=0): Promise<{ workspaceRelativePath: string; sha256: string }> {
    const nodeWorkspace = await this.createNodeWorkspace(taskId, nodeKey,revisionNumber);
    const directory = join(nodeWorkspace, 'checkpoints');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${safeSegment(resumeKey)}.checkpoint`);
    await writeFile(path, checkpoint, { mode: 0o600 });
    return { workspaceRelativePath: relative(nodeWorkspace, path), sha256: createHash('sha256').update(checkpoint).digest('hex') };
  }

  /** Writes a versioned local input made from an already archived prior delivery. */
  public async writeNodeReworkInput(taskId: string, nodeKey: string, fileName: string, content: string | Buffer, revisionNumber=0): Promise<string> {
    const nodeWorkspace = await this.createNodeWorkspace(taskId, nodeKey,revisionNumber);
    const path = join(nodeWorkspace, 'input', safeSegment(fileName));
    await mkdir(join(nodeWorkspace, 'input'), { recursive: true });
    await writeFile(path, content);
    return relative(nodeWorkspace, path);
  }

  /** Removes only named, mutable node outputs before a human-requested rework. */
  public async clearNodeReworkOutputs(taskId: string, nodeKey: string, outputPaths: readonly string[], revisionNumber=0): Promise<void> {
    const nodeWorkspace = await this.createNodeWorkspace(taskId, nodeKey,revisionNumber);
    await Promise.all(outputPaths.map(async (outputPath) => {
      const target = resolveNodeOutput(nodeWorkspace, outputPath);
      await rm(target, { recursive: true, force: true });
    }));
  }

  public async writeReworkSnapshot(taskId: string, cycle: number, snapshot: Record<string, unknown>, revisionNumber=0): Promise<string> {
    if (!Number.isInteger(cycle) || cycle < 1) throw new Error('Rework cycle must be a positive integer.');
    const path = await this.resolveTaskPath(taskId, join('session','rework',...(revisionNumber?[String(revisionNumber)]:[]),`${cycle}.json`));
    await mkdir(dirname(path), { recursive: true });
    await this.writeJson(path, snapshot);
    return path;
  }

  public async resolveTaskPath(taskId: string, taskRelativePath: string): Promise<string> {
    if (!taskRelativePath || isAbsolute(taskRelativePath)) throw new Error('Task path must be a contained relative path.');
    const root = this.taskRoot(taskId);
    const candidate = resolve(root, taskRelativePath);
    if (relative(root, candidate).startsWith('..') || isAbsolute(relative(root, candidate))) throw new Error('Task path must remain contained in the task root.');
    return candidate;
  }

  private describe(taskId: string): TaskWorkspace {
    const root = join(this.root, safeSegment(taskId));
    return {
      taskId,
      root,
      plansPath: join(root, 'plans'),
      sessionPath: join(root, 'session'),
      nodesPath: join(root, 'nodes'),
      artifactsPath: join(root, 'artifacts'),
      qualityPath: join(root, 'quality'),
    };
  }

  private async interactionDirectory(taskId: string, interactionId: string): Promise<string> {
    const path = await this.resolveTaskPath(taskId, join('interactions', safeSegment(interactionId)));
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

function safeSegment(value: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) throw new Error('Task path segment is invalid.');
  return value;
}

function resolveNodeOutput(nodeWorkspace: string, outputPath: string): string {
  if (!outputPath || isAbsolute(outputPath)) throw new Error('Node output path must be a contained relative path.');
  const target = resolve(nodeWorkspace, outputPath);
  const path = relative(nodeWorkspace, target);
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Node output path must remain contained in the node workspace.');
  return target;
}
