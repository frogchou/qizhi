import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

import type { AgentTerminalResult, TaskEnvelope } from '../../../packages/agent-protocol/src/index.js';
import type { WebSearchProvider, WebSource } from './search.js';
import { createEvent, type AgentReporter } from './reporter.js';

export async function runTask(envelope: TaskEnvelope, reporter: AgentReporter, search: WebSearchProvider): Promise<AgentTerminalResult> {
  const query = stringRequired(envelope.input.query, 'input.query');
  const maxResults = boundedNumber(envelope.input.maxResults, 5);
  let sequence = 1;
  await reporter.report(createEvent(envelope, sequence++, 'started', { capability: 'research.web' }));
  await reporter.report(createEvent(envelope, sequence++, 'progress', { stage: 'searching_public_web', maxResults }));
  const sources = await search.search(query, maxResults);
  const reportPath = join(envelope.workspacePath, 'web-research.md');
  await mkdir(envelope.workspacePath, { recursive: true });
  await writeFile(reportPath, renderReport(query, sources), 'utf8');
  const artifact = { path: relative(envelope.workspacePath, reportPath), sha256: createHash('sha256').update(await readFile(reportPath)).digest('hex') };
  const evidence = sources.map((source) => ({ source: source.url, title: source.title, excerpt: source.excerpt.slice(0, 2_000) }));
  await reporter.report(createEvent(envelope, sequence++, 'checkpoint', { sourceCount: sources.length, artifact: artifact.path }));
  const result: AgentTerminalResult = { protocolVersion: 'v1', taskId: envelope.taskId, taskNodeId: envelope.taskNodeId, instanceId: envelope.instanceId, status: 'succeeded', output: { query, sources }, evidence, risks: sources.length === 0 ? ['no_public_sources_found'] : ['public_web_sources_require_fact_check'], artifacts: [artifact] };
  await reporter.report(createEvent(envelope, sequence, 'completed', { status: result.status, sourceCount: sources.length }));
  return result;
}

function renderReport(query: string, sources: WebSource[]): string {
  return `# 互联网资料收集\n\n查询：${query}\n\n${sources.map((source, index) => `## ${index + 1}. ${source.title}\n\n${source.excerpt}\n\n来源：${source.url}`).join('\n\n') || '未找到可引用的公开来源。'}\n`;
}
function stringRequired(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`); return value.trim(); }
function boundedNumber(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) ? Math.min(10, Math.max(1, value)) : fallback; }
