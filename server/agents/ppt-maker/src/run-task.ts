import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, relative } from 'node:path';

import type { AgentTerminalResult, TaskEnvelope } from '../../../packages/agent-protocol/src/index.js';
import type { CodexRunner, CodexRuntimeStatus } from '../../../packages/codex-runtime/src/index.js';
import { createEvent, type AgentReporter } from './reporter.js';

export async function runTask(envelope: TaskEnvelope, reporter: AgentReporter, codex: CodexRunner): Promise<AgentTerminalResult> {
  const brief = requiredText(envelope.input.brief, 'input.brief');
  const title = text(envelope.input.title) || '未命名演示文稿';
  const outputPath = join(envelope.workspacePath, 'presentation.pptx');
  const qaPath = join(envelope.workspacePath, 'ppt-qa.json');
  const outputBaseline = await fileSnapshot(outputPath);
  const qaBaseline = await fileSnapshot(qaPath);
  let sequence = 1;
  await reporter.report(createEvent(envelope, sequence++, 'started', { capability: 'presentation.create' }));
  await reporter.report(createEvent(envelope, sequence++, 'progress', { stage: 'codex_generating_presentation' }));
  const execution = await codex.run({
    workspacePath: envelope.workspacePath,
    prompt: buildPrompt({ brief, title, audience: text(envelope.input.audience), language: text(envelope.input.language) || 'zh-CN', slideCount: numberValue(envelope.input.slideCount), referenceMaterials: stringList(envelope.input.referenceMaterials) }),
    onOutput: codexOutputReporter(envelope, reporter),
    onStatus: codexStatusReporter(envelope, reporter),
  });
  await requireFreshFile(outputPath, outputBaseline);
  await requireFreshFile(qaPath, qaBaseline);
  const qa = JSON.parse(await readFile(qaPath, 'utf8')) as Record<string, unknown>;
  const artifact = { path: relative(envelope.workspacePath, outputPath), sha256: await sha256(outputPath) };
  await reporter.report(createEvent(envelope, sequence++, 'checkpoint', { artifact: artifact.path, qaPassed: qa.passed === true }));
  const result: AgentTerminalResult = { protocolVersion: 'v1', taskId: envelope.taskId, taskNodeId: envelope.taskNodeId, instanceId: envelope.instanceId, status: 'succeeded', output: { title, qa, codexSummary: execution.lastMessage.trim() }, evidence: [], risks: qa.passed === true ? [] : ['presentation_qa_not_passed'], artifacts: [artifact] };
  await reporter.report(createEvent(envelope, sequence, 'completed', { status: result.status, artifact: artifact.path }));
  return result;
}

function codexOutputReporter(envelope: TaskEnvelope, reporter: AgentReporter): (entry: { stream: 'stdout' | 'stderr'; chunk: string }) => Promise<void> {
  let sequence = 100_000;
  return async (entry) => reporter.report(createEvent(envelope, sequence++, 'output', { stream: entry.stream, text: entry.chunk }));
}

function codexStatusReporter(envelope: TaskEnvelope, reporter: AgentReporter): (status: CodexRuntimeStatus) => Promise<void> {
  let sequence = 200_000;
  return async (status) => reporter.report(createEvent(envelope, sequence++, 'heartbeat', { runtime: 'codex', ...status }));
}

function buildPrompt(input: { brief: string; title: string; audience: string; language: string; slideCount?: number; referenceMaterials: string[] }): string {
  return `You are the PPT production runtime. Work only inside the current task directory. Create a professional PowerPoint file named presentation.pptx for this brief: ${JSON.stringify(input)}. Reference materials are task-local relative paths: read every listed file before making factual claims, preserve provenance, and clearly flag insufficient evidence instead of inventing project facts. If reference materials include retry-context-*.md, this is an approved human-requested rework: you MUST read that context together with the previous PPT, quality assessment and acceptance criteria it names, then correct every stated failure rather than repeating the prior delivery unchanged. Use Node.js and PptxGenJS, with a fresh presentation instance and 16:9 layout. Do not use # in PPTX hex colors, do not use unicode bullet glyphs, and preserve source URLs in speaker notes or a source slide when materials are used.\n\nMandatory quality loop: (1) check content completeness against the brief; (2) render the PPTX to PDF or slide images using LibreOffice if available and inspect for clipping, overlap, unreadable text, and missing visual hierarchy; (3) fix any issue found; (4) render/check again. Write ppt-qa.json containing { passed: boolean, checks: string[], issues: string[], rendered: boolean, slideCount: number }. Do not claim passed when the checks fail. In your final response, state the created files and remaining risks.`;
}

function requiredText(value: unknown, name: string): string { const result = text(value); if (!result) throw new Error(`${name} must be a non-empty string.`); return result; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) ? value : undefined; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
async function sha256(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex'); }

type FileSnapshot = { sha256: string; size: number; mtimeMs: number };

async function fileSnapshot(path: string): Promise<FileSnapshot | undefined> {
  try {
    const [content, metadata] = await Promise.all([readFile(path), stat(path)]);
    return { sha256: createHash('sha256').update(content).digest('hex'), size: metadata.size, mtimeMs: metadata.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requireFreshFile(path: string, baseline: FileSnapshot | undefined): Promise<void> {
  const current = await fileSnapshot(path);
  if (!current) throw new Error(`Codex did not produce required output ${basename(path)}.`);
  if (baseline && current.sha256 === baseline.sha256 && current.size === baseline.size && current.mtimeMs === baseline.mtimeMs) {
    throw new Error(`Codex did not produce fresh ${basename(path)}; a prior attempt output remains unchanged.`);
  }
}
