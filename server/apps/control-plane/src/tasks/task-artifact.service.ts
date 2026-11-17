import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DataSource, EntityManager } from 'typeorm';

import { TaskWorkspaceService } from './task-workspace.service.js';

export type ArtifactInput = { path: string; sha256: string };
export type TaskArtifactRecord = {
  id: string;
  taskId: string;
  taskNodeId: string;
  taskAttemptId: string;
  revision: number;
  originalPath: string;
  storagePath: string;
  fileName: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};

type ArchiveInput = { taskId: string; taskNodeId: string; taskAttemptId: string; nodeWorkspace: string; artifacts: ArtifactInput[] };

/**
 * Converts verified, node-local results into immutable task deliverables.
 * Database metadata is the only authority used by later download endpoints.
 */
export class TaskArtifactService {
  public constructor(private readonly dataSource: DataSource, private readonly workspaces: TaskWorkspaceService) {}

  public async archiveVerifiedArtifacts(input: ArchiveInput): Promise<TaskArtifactRecord[]> {
    if (!input.artifacts.length) return [];
    const seen = new Set<string>();
    const revision = await this.nextRevision(input.taskNodeId);
    const records: TaskArtifactRecord[] = [];
    const taskRoot = this.workspaces.taskRoot(input.taskId);
    const realTaskRoot = await realpath(taskRoot);

    for (const artifact of input.artifacts) {
      const segments = safeArtifactSegments(artifact.path);
      const identity = segments.join('/');
      if (seen.has(identity)) throw new BadRequestException(`Artifact ${artifact.path} was declared more than once.`);
      seen.add(identity);
      const source = containedPath(input.nodeWorkspace, segments, 'Agent artifact path');
      await assertRegularContainedFile(input.nodeWorkspace, source, 'Agent artifact path');
      const content = await readFile(source);
      const actualHash = createHash('sha256').update(content).digest('hex');
      if (actualHash !== artifact.sha256) throw new BadRequestException(`Artifact ${artifact.path} SHA-256 does not match.`);

      const storagePath = join('artifacts', 'nodes', safeSegment(input.taskNodeId), `revision-${revision}`, ...segments);
      const destination = await this.workspaces.resolveTaskPath(input.taskId, storagePath);
      await mkdir(dirname(destination), { recursive: true });
      await assertRealContainedDirectory(realTaskRoot, dirname(destination), 'Artifact archive path');
      await copyFile(source, destination, constants.COPYFILE_EXCL);

      records.push({
        id: randomUUID(), taskId: input.taskId, taskNodeId: input.taskNodeId, taskAttemptId: input.taskAttemptId,
        revision, originalPath: identity, storagePath, fileName: basename(segments.at(-1) ?? 'artifact'),
        mediaType: mediaTypeFor(segments.at(-1) ?? ''), sha256: actualHash, sizeBytes: content.byteLength,
        createdAt: new Date().toISOString(),
      });
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        for (const record of records) {
          await manager.query(`INSERT INTO task_artifacts (id, task_id, task_node_id, task_attempt_id, revision, original_path, storage_path, file_name, media_type, sha256, size_bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
            record.id, record.taskId, record.taskNodeId, record.taskAttemptId, record.revision, record.originalPath,
            record.storagePath, record.fileName, record.mediaType, record.sha256, record.sizeBytes, record.createdAt,
          ]);
        }
      });
    } catch (error) {
      // The files remain task-local but are intentionally undiscoverable unless
      // their metadata transaction commits. A later retention job may collect
      // such orphaned staging copies without risking an unverified download.
      throw error;
    }
    return records;
  }

  public async list(taskId: string): Promise<TaskArtifactRecord[]> {
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(`SELECT id, task_id, task_node_id, task_attempt_id, revision, original_path, storage_path, file_name, media_type, sha256, size_bytes, created_at FROM task_artifacts WHERE task_id=$1 ORDER BY created_at DESC, revision DESC, file_name`, [taskId]);
    return rows.map(toRecord);
  }

  public async listForAttempt(taskId: string, taskAttemptId: string): Promise<TaskArtifactRecord[]> {
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(`SELECT id, task_id, task_node_id, task_attempt_id, revision, original_path, storage_path, file_name, media_type, sha256, size_bytes, created_at FROM task_artifacts WHERE task_id=$1 AND task_attempt_id=$2 ORDER BY file_name`, [taskId, taskAttemptId]);
    return rows.map(toRecord);
  }

  public async openForDownload(taskId: string, artifactId: string, db:Pick<EntityManager,'query'>=this.dataSource): Promise<TaskArtifactRecord & { content: Buffer }> {
    const rows = await db.query<Array<Record<string, unknown>>>(`SELECT id, task_id, task_node_id, task_attempt_id, revision, original_path, storage_path, file_name, media_type, sha256, size_bytes, created_at FROM task_artifacts WHERE task_id=$1 AND id=$2`, [taskId, artifactId]);
    if (!rows[0]) throw new NotFoundException('Artifact was not found for this task.');
    const record = toRecord(rows[0]);
    const taskRoot = this.workspaces.taskRoot(taskId);
    const source = await this.workspaces.resolveTaskPath(taskId, record.storagePath);
    const archiveRoot = resolve(taskRoot, 'artifacts');
    if (!isContained(archiveRoot, source)) throw new BadRequestException('Artifact storage path is invalid.');
    await assertRegularContainedFile(taskRoot, source, 'Artifact storage path');
    const content = await readFile(source);
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== record.sha256) throw new BadRequestException('Archived artifact integrity check failed.');
    return { ...record, content };
  }

  private async nextRevision(taskNodeId: string): Promise<number> {
    const rows = await this.dataSource.query<Array<{ revision: string | number }>>(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM task_artifacts WHERE task_node_id=$1`, [taskNodeId]);
    return Number(rows[0]?.revision ?? 1);
  }
}

function toRecord(row: Record<string, unknown>): TaskArtifactRecord {
  return {
    id: text(row.id), taskId: text(row.task_id), taskNodeId: text(row.task_node_id), taskAttemptId: text(row.task_attempt_id),
    revision: Number(row.revision), originalPath: text(row.original_path), storagePath: text(row.storage_path),
    fileName: text(row.file_name), mediaType: text(row.media_type), sha256: text(row.sha256), sizeBytes: Number(row.size_bytes),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function safeArtifactSegments(path: string): string[] {
  if (!path || isAbsolute(path)) throw new BadRequestException('Artifact path must be a contained relative path.');
  const segments = path.split(/[\\/]+/);
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) throw new BadRequestException('Artifact path must be a contained relative path.');
  return segments;
}

function safeSegment(value: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new BadRequestException('Artifact owner identifier is invalid.');
  return value;
}

function containedPath(root: string, segments: string[], label: string): string {
  const candidate = resolve(root, ...segments);
  if (!isContained(root, candidate)) throw new BadRequestException(`${label} escapes its workspace.`);
  return candidate;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return Boolean(path) && !path.startsWith('..') && !isAbsolute(path);
}

async function assertRealContainedDirectory(realRoot: string, directory: string, label: string): Promise<void> {
  let actual: string;
  try { actual = await realpath(directory); } catch { throw new BadRequestException(`${label} is unavailable.`); }
  if (!isContained(realRoot, actual)) throw new BadRequestException(`${label} escapes the task workspace.`);
}

async function assertRegularContainedFile(root: string, path: string, label: string): Promise<void> {
  const realRoot = await realpath(root);
  let actual: string;
  let file;
  try { actual = await realpath(path); file = await lstat(path); } catch { throw new BadRequestException(`${label} is missing from the workspace.`); }
  if (!isContained(realRoot, actual) || file.isSymbolicLink() || !file.isFile()) throw new BadRequestException(`${label} must be a regular task-local file.`);
}

function mediaTypeFor(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.csv': return 'text/csv; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
