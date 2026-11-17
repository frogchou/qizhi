import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AgentTerminalResult, TaskEnvelope } from '../../../packages/agent-protocol/src/index.js';
import type { CodexRunner, CodexRuntimeStatus } from '../../../packages/codex-runtime/src/index.js';
import { createEvent, type AgentReporter } from './reporter.js';

type Assessment = { passed: boolean; criteria: Array<Record<string, unknown>>; findings: Array<Record<string, unknown>>; summary: string };

export async function runTask(envelope: TaskEnvelope, reporter: AgentReporter, codex: CodexRunner): Promise<AgentTerminalResult> {
  const requirements = requiredText(envelope.input.requirements, 'input.requirements');
  const targets = validateTargets(envelope.workspacePath, envelope.input.targets);
  await Promise.all(targets.map((target) => access(join(envelope.workspacePath, target))));
  const targetType = enumValue(envelope.input.targetType, ['document', 'code', 'mixed'], 'mixed');
  const level = enumValue(envelope.input.acceptanceLevel, ['strict', 'standard'], 'standard');
  const assessmentPath = join(envelope.workspacePath, 'quality-assessment.json');
  let sequence = 1;
  await reporter.report(createEvent(envelope, sequence++, 'started', { capability: 'quality.define_and_verify' }));
  await reporter.report(createEvent(envelope, sequence++, 'progress', { stage: 'creating_acceptance_criteria', targetCount: targets.length }));
  const execution = await codex.run({ workspacePath: envelope.workspacePath, prompt: buildPrompt(requirements, targets, targetType, level), onOutput: codexOutputReporter(envelope, reporter), onStatus: codexStatusReporter(envelope, reporter) });
  await access(assessmentPath);
  const assessment = JSON.parse(await readFile(assessmentPath, 'utf8')) as Assessment;
  validateAssessment(assessment);
  const criteriaPath = join(envelope.workspacePath, 'acceptance-criteria.json');
  await mkdir(envelope.workspacePath, { recursive: true });
  await writeFile(criteriaPath, `${JSON.stringify(assessment.criteria, null, 2)}\n`, 'utf8');
  const artifacts = await Promise.all([assessmentPath, criteriaPath].map(async (path) => ({ path: relative(envelope.workspacePath, path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  await reporter.report(createEvent(envelope, sequence++, 'checkpoint', { passed: assessment.passed, findings: assessment.findings.length }));
  const result: AgentTerminalResult = { protocolVersion: 'v1', taskId: envelope.taskId, taskNodeId: envelope.taskNodeId, instanceId: envelope.instanceId, status: 'succeeded', output: { passed: assessment.passed, criteria: assessment.criteria, findings: assessment.findings, summary: assessment.summary, codexSummary: execution.lastMessage.trim() }, evidence: [], risks: assessment.passed ? [] : ['quality_acceptance_failed'], artifacts };
  await reporter.report(createEvent(envelope, sequence, 'completed', { status: result.status, passed: assessment.passed }));
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

function buildPrompt(requirements: string, targets: string[], targetType: string, level: string): string {
  return `You are an independent quality manager. Work only in the current task directory. Do not edit the supplied targets.\n\nUser requirements: ${JSON.stringify(requirements)}\nTarget type: ${targetType}; acceptance level: ${level}; target files: ${JSON.stringify(targets)}.\n\nFirst translate the requirements into objective, testable acceptance criteria. Then inspect the listed files. For code, run only safe verification commands needed to substantiate findings; for documents, verify factual structure, completeness, consistency, traceability and presentation. Do not invent test results. Write quality-assessment.json with exactly this JSON structure: { passed:boolean, criteria:[{id,criterion,method,required}], findings:[{severity,message,path?}], summary:string }. `;
}

function validateTargets(workspace: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('input.targets must contain at least one path.');
  const root = resolve(workspace);
  return value.map((candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim() || isAbsolute(candidate)) throw new Error('Target paths must be non-empty relative paths.');
    const resolved = resolve(root, candidate);
    const taskRelativePath = relative(root, resolved);
    if (taskRelativePath === '..' || taskRelativePath.startsWith(`..${sep}`) || isAbsolute(taskRelativePath)) throw new Error('Target paths must stay inside the task workspace.');
    return taskRelativePath;
  });
}
function validateAssessment(value: Assessment): void {
  if (!value || typeof value.passed !== 'boolean' || !Array.isArray(value.criteria) || !Array.isArray(value.findings) || typeof value.summary !== 'string') throw new Error('quality-assessment.json does not match the required assessment shape.');
}
function requiredText(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value.trim(); }
function enumValue(value: unknown, allowed: string[], fallback: string): string { return typeof value === 'string' && allowed.includes(value) ? value : fallback; }
