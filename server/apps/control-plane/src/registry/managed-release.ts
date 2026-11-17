import { BadRequestException, ConflictException } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { AgentManifestSchema, type AgentManifest } from '../../../../packages/agent-protocol/src/index.js';

export const packageKey = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;
export type ReleaseRequest = {
  intent: 'create' | 'upgrade';
  template?: 'codex-text';
  packageName?: string;
  agentId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  instructions?: string;
};
export function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version))
    throw new BadRequestException('版本号需为 X.Y.Z');
  return version.split('.').map(Number);
}
export function newer(version: string, previous: string): boolean {
  // Package declarations can include prerelease/build suffixes. Build metadata does not affect precedence.
  const parts = (tag: string) => {
    const [major, minor, patch, prerelease] = tag.split('+', 1)[0]
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)?.slice(1) ?? [];
    if (!patch) throw new BadRequestException('智能体声明中版本号无效');
    return { core: [major, minor, patch].map(BigInt), pre: prerelease?.split('.') ?? [] };
  };
  const left = parts(version);
  const right = parts(previous);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i];
  if (!left.pre.length || !right.pre.length) return !left.pre.length && right.pre.length > 0;
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i], b = right.pre[i];
    if (a === b) continue;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) return BigInt(a) > BigInt(b);
    return an === bn ? a > b : !an;
  }
  return left.pre.length > right.pre.length;
}
export async function declaredPackage(root: string, name: string) {
  if (!packageKey.test(name)) throw new BadRequestException('无效的包目录名称');
  const dir = await realpath(join(root, name));
  if (dir !== join(await realpath(root), name) || dirname(dir) !== (await realpath(root))) throw new BadRequestException('包目录超出已配置的智能体目录');
  const path = join(dir, 'agent.yaml');
  if ((await realpath(path)) !== path) throw new BadRequestException('声明文件不应为符号链接');
  const value: unknown = parse(await readFile(path, 'utf8'));
  if (!Value.Check(AgentManifestSchema, value)) throw new BadRequestException('智能体声明无效');
  return { dir, manifest: value };
}
function bounded(value: unknown, max: number, name: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || value.includes('\0'))
    throw new BadRequestException(`无效字段：${name}`);
  return value.trim();
}
export function templateDeclaration(request: ReleaseRequest) {
  const id = bounded(request.agentId, 63, 'agentId');
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) throw new BadRequestException('标识仅支持小写字母、数字与连字符');
  const version = bounded(request.version, 24, 'version');
  versionParts(version);
  return {
    agentId: id,
    version,
    displayName: bounded(request.displayName, 100, 'displayName'),
    description: bounded(request.description, 500, 'description'),
    instructions: bounded(request.instructions, 8000, 'instructions'),
  };
}
export async function publishTextPackage(root: string, draft: ReturnType<typeof templateDeclaration>) {
  // The operator supplies text only. Both executable entry points reference installed, versioned platform code.
  const base = await realpath(root),
    packageName = `qizhi-${draft.agentId}-v${draft.version}`;
  const destination = join(base, packageName);
  const staging = await mkdtemp(join(base, '.release-'));
  const runner = resolve(process.cwd(), 'packages/managed-text/src/main.ts');
  const tsx = resolve(process.cwd(), 'node_modules/.bin/tsx');
  const manifest: AgentManifest = {
    protocolVersion: 'v1',
    agentId: draft.agentId,
    version: draft.version,
    displayName: draft.displayName,
    runtime: 'codex',
    entryCommand: [tsx, runner, join(destination, 'profile.json')],
    selfCheckCommand: `${tsx} ${resolve(process.cwd(), 'packages/managed-text/src/self-check.ts')}`,
    capabilities: [
      { name: `enterprise.${draft.agentId.replaceAll('-', '_')}.write`, description: draft.description },
    ],
  };
  const schema = (name: string) => ({
    type: 'object',
    additionalProperties: false,
    required: [name],
    properties: { [name]: { type: 'string', minLength: 1 }, ...(name==='brief'?{
      referenceMaterials:{type:'array',items:{type:'string'},description:'显式绑定的 UTF-8 文本、Markdown 等资料路径。二进制文档请选择支持相应格式的能力。'}
    }:{}) },
  });
  try {
    await mkdir(join(staging, 'schemas'));
    await Promise.all([
      writeFile(join(staging, 'agent.yaml'), stringify(manifest)),
      writeFile(join(staging, 'profile.json'), JSON.stringify({ instructions: draft.instructions })),
      writeFile(join(staging, 'schemas/input.schema.json'), JSON.stringify(schema('brief'))),
      writeFile(join(staging, 'schemas/result.schema.json'), JSON.stringify(schema('text'))),
    ]);
    await rename(staging, destination);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOTEMPTY' ||
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    )
      throw new ConflictException('该版本的发布目录已存在');
    throw error;
  } finally {
    // Only this invocation's own mkdtemp directory. A published release is preserved even if registration must be retried.
    await rm(staging, { recursive: true, force: true });
  }
  return packageName;
}
