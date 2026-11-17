import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DataSource, EntityManager } from 'typeorm';

import { TaskWorkspaceService } from './task-workspace.service.js';

export const TASK_INPUT_OWNER = 'administrator';
export const DEFAULT_MAX_TASK_INPUT_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_TASK_INPUT_COUNT = 25;
export const DEFAULT_MAX_TASK_INPUT_TOTAL_BYTES = 500 * 1024 * 1024;

type BasketSource = 'qizhi_local_file' | 'ragflow_chunk' | 'ragflow_document';
type InputOrigin = { sourceType: BasketSource; basketItemId: string };

/** Source labels describe the operator's uploaded bytes; they never authorize a server-side read. */
export function uploadOrigin(source: unknown, id: unknown): InputOrigin | undefined {
  if (source === undefined && id === undefined) return undefined;
  if ((source !== 'qizhi_local_file' && source !== 'ragflow_chunk' && source !== 'ragflow_document') ||
      typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new BadRequestException('资料筐来源或条目标识无效。');
  }
  return {sourceType: source, basketItemId: id};
}

type UploadRow = {
  sourceType: BasketSource | 'uploaded_file';
  basketItemId: string | null;
  id: string;
  ownerSubject: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number | string;
  sha256: string;
  storageKey: string;
  state: string;
  expiresAt: Date | string;
};

type InputRow = {
  id: string;
  taskId: string;
  sourceType: string;
  displayName: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number | string;
  sha256: string;
  workspaceRelativePath: string;
  sourceRef: Record<string, unknown> | string;
  provenance: Record<string, unknown> | string;
  createdAt: Date | string;
};

export type TaskInputSummary = {
  id: string;
  sourceType: string;
  displayName: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  provenance: Record<string, unknown>;
  createdAt: string;
};

export type TaskInputBindingMaterial = TaskInputSummary & { workspaceRelativePath: string };

/**
 * Stores user-supplied material in a short-lived staging area, then makes an
 * immutable task-local copy. Agent processes never receive staging paths.
 */
export class TaskInputService {
  private readonly stagingRoot: string;
  private readonly maxFileBytes: number;
  private readonly maxInputCount: number;
  private readonly maxTotalBytes: number;

  public constructor(
    private readonly dataSource: DataSource,
    private readonly workspaces: TaskWorkspaceService,
    config: { workspaceRoot: string; maxFileBytes?: number; maxInputCount?: number; maxTotalBytes?: number },
  ) {
    this.stagingRoot = resolve(config.workspaceRoot, '..', 'uploads');
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_TASK_INPUT_FILE_BYTES;
    this.maxInputCount = config.maxInputCount ?? DEFAULT_MAX_TASK_INPUT_COUNT;
    this.maxTotalBytes = config.maxTotalBytes ?? DEFAULT_MAX_TASK_INPUT_TOTAL_BYTES;
  }

  public limits(): { maxFileBytes: number; maxInputCount: number; maxTotalBytes: number } {
    return { maxFileBytes: this.maxFileBytes, maxInputCount: this.maxInputCount, maxTotalBytes: this.maxTotalBytes };
  }

  public async stageUpload(input: { ownerSubject?: string; originalFilename: string; mediaType?: string; stream: Readable; origin?: InputOrigin }): Promise<TaskInputSummary & { expiresAt: string }> {
    const ownerSubject = input.ownerSubject ?? TASK_INPUT_OWNER;
    const originalFilename = validatedFileName(input.originalFilename);
    const mediaType = validatedMediaType(input.mediaType);
    const id = randomUUID();
    const storageKey = join(id, 'blob');
    const target = this.stagingPath(storageKey);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > thisMaxFileBytes) {
          callback(new BadRequestException(`附件超过单文件限制（${thisMaxFileBytes} 字节）。`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const thisMaxFileBytes = this.maxFileBytes;

    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await pipeline(input.stream, meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      if ((input.stream as Readable & { truncated?: boolean }).truncated) throw new BadRequestException(`附件超过单文件限制（${this.maxFileBytes} 字节）。`);
      if (sizeBytes === 0) throw new BadRequestException('不允许上传空文件。');
      const sha256 = hash.digest('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      await this.dataSource.query(
        `INSERT INTO task_input_uploads (id, owner_subject, original_filename, media_type, size_bytes, sha256, storage_key, state, expires_at, source_type, basket_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10)`,
        [id, ownerSubject, originalFilename, mediaType, sizeBytes, sha256, storageKey, expiresAt, input.origin?.sourceType ?? 'uploaded_file', input.origin?.basketItemId ?? null],
      );
      await this.audit({ uploadId: id, action: 'uploaded', actorSubject: ownerSubject, detail: { originalFilename, mediaType, sizeBytes, sha256 } });
      return { id, sourceType: input.origin?.sourceType ?? 'uploaded_file', displayName: originalFilename, originalFilename, mediaType, sizeBytes, sha256, provenance: { uploadId: id, ...input.origin }, createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString() };
    } catch (error) {
      await rm(dirname(target), { recursive: true, force: true });
      throw error;
    }
  }

  /** Converts ready uploads to task-owned snapshots. An upload may be consumed once only. */
  public async freezeForTask(taskId: string, uploadIds: readonly string[], ownerSubject = TASK_INPUT_OWNER): Promise<TaskInputSummary[]> {
    if (!uploadIds.length) return [];
    return this.withFrozenUploads(taskId,uploadIds,ownerSubject,async (_manager,freeze) => freeze());
  }

  /** Holds the task/upload rows until the consuming action and its immutable input records commit together. */
  public async withFrozenUploads<T>(taskId: string, uploadIds: readonly string[], ownerSubject: string,
    consume: (manager: EntityManager, freeze: () => Promise<TaskInputSummary[]>) => Promise<T>): Promise<T> {
    if (uploadIds.length > this.maxInputCount) throw new BadRequestException(`一个任务最多可附加 ${this.maxInputCount} 个文件。`);
    if (new Set(uploadIds).size !== uploadIds.length) throw new BadRequestException('同一附件不能在一个任务中重复引用。');
    if (uploadIds.some((id) => !isIdentifier(id))) throw new BadRequestException('附件标识无效。');

    const copies: Array<{ input: TaskInputSummary; upload: UploadRow; destination: string }> = [];
    const createdDirectories: string[] = [];
    let result: T;
    try {
      result = await this.dataSource.transaction(async manager => {
        await manager.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
        return consume(manager, async () => {
          if (!uploadIds.length) return [];
          const uploads = await manager.query<UploadRow[]>(`
            SELECT id, owner_subject AS "ownerSubject", original_filename AS "originalFilename", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256, storage_key AS "storageKey", state, expires_at AS "expiresAt", source_type AS "sourceType", basket_item_id AS "basketItemId"
            FROM task_input_uploads WHERE id = ANY($1::text[]) AND owner_subject=$2 AND state='ready' AND expires_at > now() ORDER BY id FOR UPDATE
          `, [uploadIds, ownerSubject]);
          if (uploads.length !== uploadIds.length) throw new BadRequestException('存在未知、过期或已被使用的附件。请重新上传后提交。');
          const totalBytes = uploads.reduce((sum, upload) => sum + Number(upload.sizeBytes), 0);
          if (totalBytes > this.maxTotalBytes) throw new BadRequestException(`附件总量超过任务限制（${this.maxTotalBytes} 字节）。`);
          const [existing] = await manager.query<Array<{count:string;bytes:string}>>(
            "SELECT count(*) AS count,coalesce(sum(size_bytes),0) AS bytes FROM task_inputs WHERE task_id=$1 AND NOT(source_type='agent_artifact' AND provenance ? 'artifactId')",[taskId]);
          if (Number(existing.count)+uploads.length>this.maxInputCount || Number(existing.bytes)+totalBytes>this.maxTotalBytes)
            throw new BadRequestException('本次新增资料超过工单附件数量或总字节限制。');
          for (const upload of uploads) {
            const source = this.stagingPath(upload.storageKey);
            const sourceInfo = await lstat(source);
            if (!sourceInfo.isFile() || sourceInfo.size !== Number(upload.sizeBytes) || await sha256ForFile(source) !== upload.sha256) {
              throw new BadRequestException('附件暂存校验失败，请重新上传。');
            }
            const id = randomUUID();
            const storageName = storedFileName(upload.originalFilename);
            const workspaceRelativePath = join('inputs', id, 'original', storageName);
            const destination = await this.workspaces.resolveTaskPath(taskId, workspaceRelativePath);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            createdDirectories.push(dirname(dirname(destination)));
            await copyFile(source, destination);
            if (await sha256ForFile(destination) !== upload.sha256) throw new Error('任务资料快照的摘要校验失败。');
            const provenance = { sourceType: upload.sourceType, uploadId: upload.id, ...(upload.basketItemId ? { basketItemId: upload.basketItemId } : {}), frozenAt: new Date().toISOString() };
            await writeFile(join(dirname(dirname(destination)), 'provenance.json'), `${JSON.stringify({ id, originalFilename: upload.originalFilename, mediaType: upload.mediaType, sizeBytes: Number(upload.sizeBytes), sha256: upload.sha256, ...provenance }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            copies.push({
              input: { id, sourceType: upload.sourceType, displayName: upload.originalFilename, originalFilename: upload.originalFilename, mediaType: upload.mediaType, sizeBytes: Number(upload.sizeBytes), sha256: upload.sha256, provenance, createdAt: new Date().toISOString() },
              upload,
              destination,
            });
          }
          for (const copy of copies) {
            const workspaceRelativePath = relative(this.workspaces.taskRoot(taskId), copy.destination);
            await manager.query(
              `INSERT INTO task_inputs (id, task_id, source_type, display_name, original_filename, media_type, size_bytes, sha256, workspace_relative_path, source_ref, provenance)
               VALUES ($1,$2,$11,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
              [copy.input.id, taskId, copy.input.displayName, copy.input.originalFilename, copy.input.mediaType, copy.input.sizeBytes, copy.input.sha256, workspaceRelativePath, JSON.stringify({ uploadId: copy.upload.id, ...(copy.upload.basketItemId ? {basketItemId:copy.upload.basketItemId} : {}) }), JSON.stringify(copy.input.provenance),copy.input.sourceType],
            );
            await manager.query(`UPDATE task_input_uploads SET state='consumed' WHERE id=$1 AND state='ready'`, [copy.upload.id]);
            await manager.query(`INSERT INTO task_input_audits (task_id, task_input_id, upload_id, action, actor_subject, detail) VALUES ($1,$2,$3,'frozen',$4,$5::jsonb)`, [taskId, copy.input.id, copy.upload.id, ownerSubject, JSON.stringify({ displayName: copy.input.displayName, sha256: copy.input.sha256, sizeBytes: copy.input.sizeBytes })]);
          }
          return copies.map(copy => copy.input);
        });
      });
    } catch (error) {
      // The staging uploads remain ready when the consuming transaction rolls back.
      await Promise.allSettled(createdDirectories.map(path=>rm(path,{recursive:true,force:true})));
      throw error;
    }
    await Promise.allSettled(copies.map(copy=>rm(dirname(this.stagingPath(copy.upload.storageKey)),{recursive:true,force:true})));
    return result;
  }

  /**
   * Makes answer attachments ordinary task-owned inputs, then stores a
   * second immutable copy beside the interaction that introduced them.
   * Neither the API nor an agent ever receives a staging path.
   */
  public async freezeForInteractionAnswer(taskId: string, interactionId: string, uploadIds: readonly string[], ownerSubject = TASK_INPUT_OWNER): Promise<TaskInputSummary[]> {
    if (!isIdentifier(interactionId)) throw new BadRequestException('交互标识无效。');
    const inputs = await this.freezeForTask(taskId, uploadIds, ownerSubject);
    try {
      for (const input of inputs) {
        const rows = await this.dataSource.query<InputRow[]>(`SELECT id, task_id AS "taskId", source_type AS "sourceType", display_name AS "displayName", original_filename AS "originalFilename", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256, workspace_relative_path AS "workspaceRelativePath", source_ref AS "sourceRef", provenance, created_at AS "createdAt" FROM task_inputs WHERE id=$1 AND task_id=$2`, [input.id, taskId]);
        const row = rows[0];
        if (!row) throw new Error('被冻结的交互附件未能找到。');
        const source = await this.workspaces.resolveTaskPath(taskId, row.workspaceRelativePath);
        const destination = await this.workspaces.resolveTaskPath(taskId, join('interactions', interactionId, 'attachments', input.id, 'original', storedFileName(input.originalFilename)));
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(source, destination);
        if (await sha256ForFile(destination) !== input.sha256) throw new Error('交互附件快照的摘要校验失败。');
        await this.audit({ taskId, taskInputId: input.id, action: 'interaction_answer_attachment', actorSubject: ownerSubject, detail: { interactionId, displayName: input.displayName, sha256: input.sha256, sizeBytes: input.sizeBytes } });
      }
    } catch (error) {
      await Promise.all(inputs.map((input) => this.workspaces.resolveTaskPath(taskId, join('interactions', interactionId, 'attachments', input.id)).then((path) => rm(path, { recursive: true, force: true }))));
      throw error;
    }
    return inputs;
  }

  public async listForTask(taskId: string): Promise<TaskInputSummary[]> {
    const rows = await this.dataSource.query<InputRow[]>(`
      SELECT id, task_id AS "taskId", source_type AS "sourceType", display_name AS "displayName", original_filename AS "originalFilename", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256, workspace_relative_path AS "workspaceRelativePath", source_ref AS "sourceRef", provenance, created_at AS "createdAt"
      FROM task_inputs WHERE task_id=$1 ORDER BY created_at, id
    `, [taskId]);
    return rows.map(toSummary);
  }

  public async listBindingMaterials(taskId: string): Promise<TaskInputBindingMaterial[]> {
    const rows = await this.dataSource.query<InputRow[]>(`
      SELECT id, task_id AS "taskId", source_type AS "sourceType", display_name AS "displayName", original_filename AS "originalFilename", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256, workspace_relative_path AS "workspaceRelativePath", source_ref AS "sourceRef", provenance, created_at AS "createdAt"
      FROM task_inputs WHERE task_id=$1 ORDER BY created_at, id
    `, [taskId]);
    return rows.map((row) => ({ ...toSummary(row), workspaceRelativePath: row.workspaceRelativePath }));
  }

  public async openForDownload(taskId: string, inputId: string, actorSubject = TASK_INPUT_OWNER): Promise<{ fileName: string; mediaType: string; content: Buffer }> {
    const rows = await this.dataSource.query<InputRow[]>(`
      SELECT id, task_id AS "taskId", source_type AS "sourceType", display_name AS "displayName", original_filename AS "originalFilename", media_type AS "mediaType", size_bytes AS "sizeBytes", sha256, workspace_relative_path AS "workspaceRelativePath", source_ref AS "sourceRef", provenance, created_at AS "createdAt"
      FROM task_inputs WHERE id=$1 AND task_id=$2
    `, [inputId, taskId]);
    const input = rows[0];
    if (!input) throw new NotFoundException('Task input not found.');
    const path = await this.workspaces.resolveTaskPath(taskId, input.workspaceRelativePath);
    const content = await readFile(path);
    if (content.length !== Number(input.sizeBytes) || createHash('sha256').update(content).digest('hex') !== input.sha256) throw new Error('任务资料快照完整性校验失败。');
    await this.audit({ taskId, taskInputId: inputId, action: 'downloaded', actorSubject, detail: { displayName: input.displayName, sha256: input.sha256 } });
    return { fileName: input.originalFilename, mediaType: input.mediaType, content };
  }

  private stagingPath(storageKey: string): string {
    if (!storageKey || isAbsolute(storageKey)) throw new Error('Task input staging key is invalid.');
    const path = resolve(this.stagingRoot, storageKey);
    if (relative(this.stagingRoot, path).startsWith('..') || isAbsolute(relative(this.stagingRoot, path))) throw new Error('Task input staging path escapes its root.');
    return path;
  }

  private async audit(input: { taskId?: string; taskInputId?: string; uploadId?: string; action: string; actorSubject: string; detail: Record<string, unknown> }): Promise<void> {
    await this.dataSource.query(`INSERT INTO task_input_audits (task_id, task_input_id, upload_id, action, actor_subject, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [input.taskId ?? null, input.taskInputId ?? null, input.uploadId ?? null, input.action, input.actorSubject, JSON.stringify(input.detail)]);
  }
}

function toSummary(row: InputRow): TaskInputSummary {
  return { id: row.id, sourceType: row.sourceType, displayName: row.displayName, originalFilename: row.originalFilename, mediaType: row.mediaType, sizeBytes: Number(row.sizeBytes), sha256: row.sha256, provenance: jsonObject(row.provenance), createdAt: toIso(row.createdAt) };
}

function validatedFileName(value: string): string {
  const name = value.trim().normalize('NFC');
  if (!name || name.length > 255 || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new BadRequestException('附件文件名无效。');
  return name;
}

function storedFileName(fileName: string): string {
  return validatedFileName(fileName).replace(/[<>:"|?*]/g, '_');
}

function validatedMediaType(value: string | undefined): string {
  const mediaType = (value ?? 'application/octet-stream').trim().toLowerCase();
  if (!mediaType || mediaType.length > 255 || /[\r\n\u0000]/.test(mediaType)) throw new BadRequestException('附件媒体类型无效。');
  return mediaType;
}

function isIdentifier(value: string): boolean { return /^[0-9a-f-]{36}$/i.test(value); }

async function sha256ForFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), new Transform({ transform(_chunk: Buffer, _encoding, callback) { callback(); } }));
  return hash.digest('hex');
}

function jsonObject(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value !== 'string') return value ?? {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function toIso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
