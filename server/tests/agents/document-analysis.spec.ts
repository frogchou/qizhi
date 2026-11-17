import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import { AgentManifestSchema, AgentResultSchema, validateTaskPlan, type AgentEvent, type TaskEnvelope } from '../../packages/agent-protocol/src/index';
import type { CodexRunInput, CodexRunner } from '../../packages/codex-runtime/src/index';
import { toTypeBoxSchema } from '../../apps/control-plane/src/planning/capability-schema';
import { runTask } from '../../agents/document-analysis/src/run-task';

const sourceA = '# 提交流程\n系统接收材料，安排处理任务，并保存用户可阅读的交付结果。';
const sourceB = '# 运行说明\n此工具负责将本地文档转换为可检索的文本，保留文件来源。';
const originalName = '项目说明（完整文件名不能截断，来自同名附件的不同版本）.md';
const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']).find((command) => spawnSync(command, ['--version'], { timeout: 3_000, windowsHide: true }).status === 0);

describe('document analysis agent', () => {
  it('delivers complete grounded prose and a real Markdown report for every same-name attachment', async () => {
    const task = await fixture([sourceA, sourceB]);
    const events: AgentEvent[] = [];
    const reporter = { report: vi.fn(async (event: AgentEvent) => { events.push(event); }) };
    const codex = runner(async (input) => {
      expect(input.prompt).toContain(sourceA.split('\n')[1]);
      expect(input.prompt).toContain(sourceB.split('\n')[1]);
      expect(input.prompt).toContain(originalName);
      await input.onStatus?.({ state: 'running', elapsedMs: 62_000, outputReceived: true });
      await input.onOutput?.({ stream: 'stdout', chunk: '正在整理内容' });
      return analysis();
    });

    const result = await runTask(task, reporter, codex);
    expect(Value.Check(AgentResultSchema, result)).toBe(true);
    expect(result.output.answer).toContain('管理文档处理过程');
    expect(result.output.answer).toContain('便于后续搜索与引用');
    expect(result.output.answer).toContain(originalName);
    expect(result.output.answer).toContain('input-a');
    expect(result.output.answer).toContain('input-b');
    expect(result.output.answer).not.toBe(result.output.summary);
    expect(result.output.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: 'input-a', title: originalName, path: 'input/a.md' }),
      expect.objectContaining({ documentId: 'input-b', title: originalName, path: 'input/b.md' }),
    ]));
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: 'input-a', title: originalName, source: expect.stringContaining('input-a'), excerpt: '系统接收材料，安排处理任务' }),
      expect.objectContaining({ documentId: 'input-b', title: originalName, source: expect.stringContaining('input-b'), excerpt: '此工具负责将本地文档转换为可检索的文本' }),
    ]));
    expect(result.artifacts).toHaveLength(1);
    const bytes = await readFile(join(task.workspacePath, result.artifacts[0].path));
    expect(bytes.toString('utf8')).toBe(result.output.answer);
    expect(result.artifacts[0].sha256).toBe(hash(bytes));
    expect(result.output.deliveryArtifactPaths).toEqual([result.artifacts[0].path]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'heartbeat', payload: expect.objectContaining({ runtime: 'codex', elapsedMs: 62_000 }) }),
      expect.objectContaining({ type: 'output', payload: expect.objectContaining({ text: '正在整理内容' }) }),
    ]));
    const invocation = vi.mocked(codex.run).mock.calls[0][0];
    expect(invocation.workspacePath).not.toBe(task.workspacePath);
    expect(invocation.outputSchemaPath).toContain('analysis.schema.json');
    expect(invocation.researchMode).toBe('synthesis');
    expect(invocation.timeoutMs).toBeUndefined();
    const schema = toTypeBoxSchema(JSON.parse(await readFile(resolve('agents/document-analysis/schemas/result.schema.json'), 'utf8')));
    expect(Value.Check(schema, result.output)).toBe(true);
  });

  it('uses distinct work directories and never reuses a previous report', async () => {
    const task = await fixture([sourceA, sourceB]);
    const codex = runner(async () => analysis());
    const first = await runTask(task, { report: vi.fn() }, codex);
    const second = await runTask({ ...task, attemptNumber: 2 }, { report: vi.fn() }, codex);
    expect(first.artifacts[0].path).not.toBe(second.artifacts[0].path);
    expect(vi.mocked(codex.run).mock.calls[0][0].workspacePath).not.toBe(vi.mocked(codex.run).mock.calls[1][0].workspacePath);
    const noReport = { run: vi.fn(async () => ({ lastMessage: '已分析完成，报告见工作目录。' })) };
    await expect(runTask(task, { report: vi.fn() }, noReport)).rejects.toThrow(/analysis|report|JSON/i);
    expect(noReport.run).toHaveBeenCalledTimes(2);
  });

  it.each(['../secret.md', '..\\secret.md', '/etc/passwd', 'C:\\private.md', 'C:private.md', '\\\\server\\share\\secret.md'])('rejects escaping or absolute target %s before synthesis', async (path) => {
    const task = await fixture([sourceA]);
    const codex = runner(async () => analysis());
    task.input.referenceMaterials = [path];
    await expect(runTask(task, { report: vi.fn() }, codex)).rejects.toThrow(/relative|inside|path/i);
    expect(codex.run).not.toHaveBeenCalled();
  });

  it('rejects a symlinked directory that escapes the task workspace', async () => {
    const task = await fixture([sourceA]);
    const outside = await mkdtemp(join(tmpdir(), 'document-analysis-outside-'));
    await writeFile(join(outside, 'private.md'), 'private');
    await symlink(outside, join(task.workspacePath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    task.input.referenceMaterials = ['escape/private.md'];
    await expect(runTask(task, { report: vi.fn() }, runner(async () => analysis()))).rejects.toThrow(/inside|workspace/i);
  });

  it('verifies every target exists and checks frozen file integrity before invoking Codex', async () => {
    const task = await fixture([sourceA, sourceB]);
    const codex = runner(async () => analysis());
    task.input.referenceMaterials = ['input/a.md', 'input/missing.md'];
    await expect(runTask(task, { report: vi.fn() }, codex)).rejects.toThrow(/missing|ENOENT/i);
    task.input.referenceMaterials = ['input/a.md', 'input/b.md'];
    await writeFile(join(task.workspacePath, 'input/b.md'), 'changed after binding');
    await expect(runTask(task, { report: vi.fn() }, codex)).rejects.toThrow(/integrity|checksum/i);
    expect(codex.run).not.toHaveBeenCalled();
  });

  it.each([
    { requirements: ' ', referenceMaterials: ['input/a.md'] },
    { requirements: 'a'.repeat(20_001), referenceMaterials: ['input/a.md'] },
    { requirements: 'summarize', referenceMaterials: [] },
    { requirements: 'summarize', referenceMaterials: ['input/a.md', 'input/./a.md'] },
    { requirements: 'summarize', referenceMaterials: [42] },
    { requirements: 'summarize', referenceMaterials: ['input/a.md'], undeclared: true },
  ])('validates the declared input constraints: %j', async (input) => {
    const task = await fixture([sourceA]);
    await expect(runTask({ ...task, input }, { report: vi.fn() }, runner(async () => analysis()))).rejects.toThrow(/input|path|duplicate/i);
  });

  it.each([
    ['empty.md', Buffer.from(' \n\t'), /empty|readable/i],
    ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), /unsupported/i],
    ['binary.txt', Buffer.from([0, 1, 2, 3]), /binary|text|readable/i],
  ])('does not claim to analyze an unreadable document: %s', async (name, bytes, error) => {
    const task = await fixture([sourceA]);
    await writeFile(join(task.workspacePath, name), bytes);
    task.input.referenceMaterials = [name];
    task.taskInputs = [];
    const codex = runner(async () => analysis());
    await expect(runTask(task, { report: vi.fn() }, codex)).rejects.toThrow(error);
    expect(codex.run).not.toHaveBeenCalled();
  });

  it.each([
    { overview: '', documents: [] },
    { ...analysis(), documents: analysis().documents.slice(0, 1) },
    { ...analysis(), documents: analysis().documents.map((document) => ({ ...document, evidence: ['invented source text'] })) },
  ])('rejects empty, incomplete, or ungrounded reports after one repair attempt', async (response) => {
    const task = await fixture([sourceA, sourceB]);
    const codex = runner(async () => response);
    await expect(runTask(task, { report: vi.fn() }, codex)).rejects.toThrow(/analysis|document|evidence|report/i);
    expect(codex.run).toHaveBeenCalledTimes(2);
  });

  it('can repair an incomplete response without dropping an input document', async () => {
    const task = await fixture([sourceA, sourceB]);
    let call = 0;
    const codex = runner(async () => ++call === 1 ? { ...analysis(), documents: [] } : analysis());
    const result = await runTask(task, { report: vi.fn() }, codex);
    expect(result.output.documents).toHaveLength(2);
    expect(codex.run).toHaveBeenCalledTimes(2);
  });

  it('registers a schema that allows scheduler task-input bindings and the real output fields', async () => {
    const manifest = parse(await readFile(resolve('agents/document-analysis/agent.yaml'), 'utf8'));
    expect(Value.Check(AgentManifestSchema, manifest)).toBe(true);
    const inputSchema = toTypeBoxSchema(JSON.parse(await readFile(resolve('agents/document-analysis/schemas/input.schema.json'), 'utf8')));
    const resultSchema = toTypeBoxSchema(JSON.parse(await readFile(resolve('agents/document-analysis/schemas/result.schema.json'), 'utf8')));
    expect(() => validateTaskPlan({ version: 'v1', nodes: [
      { id: 'analyze', type: 'agent_call', capability: 'document.analyze', input: { requirements: '说明文件用途', referenceMaterials: [] }, taskInputBindings: [{ target: 'referenceMaterials', inputId: 'input-a', format: 'task_input_paths' }], workspace: { mode: 'isolated' } },
      { id: 'finish', type: 'end', dependsOn: ['analyze'] },
    ] }, [{ agentId: manifest.agentId, version: manifest.version, capability: 'document.analyze', inputSchema, resultSchema }])).not.toThrow();
  });

  describe.skipIf(!python)('locally available Office text extraction', () => {
    it.each([
      ['docx', 'word/document.xml', '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Offline document conversion preserves the source.</w:t></w:r></w:p></w:body></w:document>'],
      ['pptx', 'ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:presentation" xmlns:a="urn:drawing"><p:cSld><a:p><a:r><a:t>Offline document conversion preserves the source.</a:t></a:r></a:p></p:cSld></p:sld>'],
      ['xlsx', 'xl/worksheets/sheet1.xml', '<worksheet xmlns="urn:sheet"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Offline document conversion preserves the source.</t></is></c></row></sheetData></worksheet>'],
    ])('extracts actual %s text before synthesis and states the extraction scope', async (extension, member, xml) => {
      const task = await officeFixture(extension, member, xml);
      const codex = runner(async (input) => {
        expect(input.prompt).toContain('Offline document conversion preserves the source.');
        return { overview: '该材料介绍文档转换。', documents: [{ documentId: 'input-a', purpose: '说明文档转换工具的作用。', summary: '工具离线转换文档并保留来源。', keyPoints: [], evidence: ['Offline document conversion preserves the source.'], limitations: [] }] };
      });
      const result = await runTask(task, { report: vi.fn() }, codex);
      expect(result.output.answer).toContain('工具离线转换文档并保留来源');
      expect(result.output.answer).toContain('未对图片、扫描内容、图表外观或版式进行视觉分析');
    });

    it('does not mistake synthetic slide labels for readable image-only PPTX content', async () => {
      const task = await officeFixture('pptx', 'ppt/slides/slide1.xml', '<p:sld xmlns:p="urn:presentation"><p:cSld><p:spTree/></p:cSld></p:sld>');
      const codex = runner(async () => analysis());
      await expect(runTask(task, { report: vi.fn() }, codex)).rejects.toThrow(/no readable text|image-only/i);
      expect(codex.run).not.toHaveBeenCalled();
    });
  });
});

async function officeFixture(extension: string, member: string, xml: string): Promise<TaskEnvelope> {
  const task = await fixture([sourceA]);
  const path = `input/document.${extension}`;
  const created = spawnSync(python!, ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as archive:\n archive.writestr(sys.argv[2], sys.argv[3])', join(task.workspacePath, path), member, xml], { encoding: 'utf8', windowsHide: true });
  expect(created.status, created.stderr).toBe(0);
  const bytes = await readFile(join(task.workspacePath, path));
  task.input.referenceMaterials = [path];
  task.taskInputs = [{ id: 'input-a', displayName: `完整原名.${extension}`, sourceType: 'uploaded_file', mediaType: 'application/octet-stream', sizeBytes: bytes.length, sha256: hash(bytes), path }];
  return task;
}

async function fixture(contents: string[]): Promise<TaskEnvelope> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'document-analysis-'));
  await mkdir(join(workspacePath, 'input'));
  const taskInputs = await Promise.all(contents.map(async (content, index) => {
    const letter = String.fromCharCode(97 + index);
    const path = `input/${letter}.md`;
    await writeFile(join(workspacePath, path), content, 'utf8');
    return { id: `input-${letter}`, displayName: originalName, sourceType: 'uploaded_file', mediaType: 'text/markdown', sizeBytes: Buffer.byteLength(content), sha256: hash(Buffer.from(content)), path };
  }));
  return { protocolVersion: 'v1', taskId: 'task-analysis', taskNodeId: 'node-analysis', instanceId: 'instance-analysis', attemptNumber: 1, leaseToken: 'lease-token-with-at-least-24-characters', workspacePath, input: { requirements: '分析这些文件的内容，分别总结并说明用途。', referenceMaterials: taskInputs.map((input) => input.path) }, taskInputs, callback: { url: 'http://127.0.0.1/events' } };
}

function analysis() {
  return { overview: '这两份材料分别解释任务管理与文档转换，两者都与文件处理有关。', documents: [
    { documentId: 'input-a', purpose: '管理文档处理过程，让用户拿到可阅读的结果。', summary: '材料描述接收、安排任务和保存交付结果三个环节。', keyPoints: ['接收材料后安排处理任务。'], evidence: ['系统接收材料，安排处理任务'], limitations: [] },
    { documentId: 'input-b', purpose: '将文档转成文本，便于后续搜索与引用。', summary: '材料说明本地转换的作用，并要求保留文件来源。', keyPoints: ['转换后仍保留文件来源。'], evidence: ['此工具负责将本地文档转换为可检索的文本'], limitations: [] },
  ] };
}

function runner(respond: (input: CodexRunInput) => Promise<unknown>): CodexRunner {
  return { run: vi.fn(async (input) => ({ lastMessage: JSON.stringify(await respond(input)) })) };
}

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
