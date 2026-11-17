import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';

import type { TaskEnvelope } from '../../../packages/agent-protocol/src/index.js';

const execute = promisify(execFile);
const maxFileBytes = 20 * 1024 * 1024;
const maxTextCharacters = 600_000;
const textExtensions = new Set(['', '.txt', '.md', '.markdown', '.mdx', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.html', '.htm', '.yaml', '.yml', '.rst', '.log', '.ini', '.toml', '.sql', '.tex']);
const officeExtensions = new Set(['.docx', '.pptx', '.xlsx']);

export type Material = { documentId: string; title: string; path: string; sha256: string; text: string; extractionLimitations: string[] };

/** Check both path dialects before checking the real filesystem boundary. */
export function containedRelativePath(workspacePath: string, candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 2_000 || /[\0\r\n]/.test(candidate) || isAbsolute(candidate) || win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) {
    throw new Error('Input file paths must be non-empty relative paths.');
  }
  const portable = candidate.replace(/[\\/]/g, sep);
  const path = relative(resolve(workspacePath), resolve(workspacePath, portable));
  if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('Input file paths must stay inside the task workspace.');
  return path;
}

export async function readMaterials(envelope: TaskEnvelope, paths: string[], runDirectory: string): Promise<Material[]> {
  const root = await realpath(envelope.workspacePath);
  const grants = new Map<string, NonNullable<TaskEnvelope['taskInputs']>[number]>();
  for (const grant of envelope.taskInputs ?? []) {
    const key = containedRelativePath(root, grant.path);
    if (grants.has(key)) throw new Error(`Duplicate task-input metadata for path ${key}.`);
    grants.set(key, grant);
  }
  const documents: Material[] = [];
  const ids = new Set<string>();
  let totalCharacters = 0;
  for (const path of paths) {
    const absolute = await realpath(join(root, path));
    const actualRelative = relative(root, absolute);
    if (isAbsolute(actualRelative) || actualRelative === '..' || actualRelative.startsWith(`..${sep}`)) throw new Error(`Input file ${path} must stay inside the task workspace.`);
    const metadata = await stat(absolute);
    if (!metadata.isFile()) throw new Error(`Input path ${path} must name a regular file.`);
    if (metadata.size > maxFileBytes) throw new Error(`Input file ${path} exceeds the 20 MiB extraction limit; it was not truncated.`);
    const bytes = await readFile(absolute);
    if (bytes.length > maxFileBytes) throw new Error(`Input file ${path} exceeds the 20 MiB extraction limit; it was not truncated.`);
    const sha256 = hash(bytes);
    const grant = grants.get(path);
    if (grant && (grant.sizeBytes !== bytes.length || grant.sha256 !== sha256)) throw new Error(`Input integrity/checksum mismatch for ${grant.displayName} [${grant.id}].`);
    const documentId = grant?.id ?? `file-${hash(Buffer.from(path)).slice(0, 24)}`;
    if (ids.has(documentId)) throw new Error(`Duplicate document binding ID ${documentId}.`);
    ids.add(documentId);
    const title = grant?.displayName ?? basename(path);
    const extension = extname(title).toLowerCase();
    // Extraction uses a verified snapshot rather than re-reading mutable source paths.
    const text = await extractText(bytes, extension, grant?.mediaType, runDirectory, documents.length);
    if (!text.trim()) throw new Error(`Input document ${title} [${documentId}] contains no readable text (empty or image-only); analysis was not produced.`);
    totalCharacters += text.length;
    if (totalCharacters > maxTextCharacters) throw new Error('Input documents exceed the 600000 extracted-character limit; no file was silently truncated.');
    const extractionLimitations = extension === '.pdf' || officeExtensions.has(extension)
      ? ['本报告依据文件中可提取的文字；未对图片、扫描内容、图表外观或版式进行视觉分析。'] : [];
    documents.push({ documentId, title, path: path.split(sep).join('/'), sha256, text, extractionLimitations });
  }
  return documents;
}

async function extractText(bytes: Buffer, extension: string, mediaType: string | undefined, runDirectory: string, index: number): Promise<string> {
  if (textExtensions.has(extension) || mediaType?.startsWith('text/')) return decodeText(bytes);
  if (extension !== '.pdf' && !officeExtensions.has(extension)) throw new Error(`Unsupported document format ${extension || mediaType || 'unknown'}; this agent cannot truthfully read it.`);
  const sources = join(runDirectory, 'sources');
  await mkdir(sources, { recursive: true });
  const snapshot = join(sources, `${index + 1}${extension}`);
  await writeFile(snapshot, bytes, { flag: 'wx' });
  if (extension === '.pdf') {
    try {
      const result = await execute('pdftotext', ['-enc', 'UTF-8', '-layout', snapshot, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true });
      return result.stdout.replace(/\r\n?/g, '\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('PDF text extraction failed; encrypted, malformed, or over-limit PDFs are not supported.');
    }
  }
  const commands = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const command of commands) {
    try {
      const result = await execute(command, [join(__dirname, 'extract-office.py'), snapshot, extension], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      return result.stdout.replace(/\r\n?/g, '\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const detail = (error as { stderr?: string }).stderr?.trim().slice(0, 500);
      throw new Error(`Local ${extension} text extraction failed${detail ? `: ${detail}` : '.'}`);
    }
  }
  throw new Error(`Unsupported ${extension} extraction on this host: Python is unavailable${extension === '.pdf' ? ' and pdftotext is unavailable' : ''}.`);
}

function decodeText(bytes: Buffer): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('Input text is not valid UTF-8 or BOM-marked UTF-16; no analysis was produced.'); }
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('Input contains binary control bytes and cannot be treated as readable text.');
  return text.replace(/\r\n?/g, '\n');
}

export function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
