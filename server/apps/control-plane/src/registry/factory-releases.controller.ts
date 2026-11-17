import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AdminAuthGuard } from '../config/auth.guard.js';
import { TASK_RUNTIME_CONFIG, type TaskRuntimeConfig } from '../tasks/tasks.service.js';
import {
  declaredPackage,
  newer,
  packageKey,
  publishTextPackage,
  templateDeclaration,
  type ReleaseRequest,
} from './managed-release.js';
import { RegistryService } from './registry.service.js';

@Controller('/v1/factory')
@UseGuards(AdminAuthGuard)
export class FactoryReleaseController {
  private readonly root: string;
  private publication: Promise<void> = Promise.resolve();
  constructor(
    @Inject(RegistryService) private readonly registry: RegistryService,
    @Inject(TASK_RUNTIME_CONFIG) config: TaskRuntimeConfig,
  ) {
    this.root = resolve(config.agentPackageRoot ?? join(process.cwd(), 'agents'));
  }
  @Get('packages')
  async catalog() {
    const versions = await this.registry.list(true);
    const statuses = new Map(versions.map((row) => [row.agentId + '@' + row.version, row.status]));
    const entries = await readdir(this.root, { withFileTypes: true });
    const found = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && packageKey.test(e.name))
        .map(async (e) => {
          try {
            const { manifest: m } = await declaredPackage(this.root, e.name);
            const status = statuses.get(m.agentId + '@' + m.version);
            if (status === 'deleted' || status === 'deleting') return null;
            return {
              packageName: e.name,
              agentId: m.agentId,
              version: m.version,
              displayName: m.displayName,
              status: status ?? null,
              declared: true,
            };
          } catch {
            return null;
          }
        }),
    );
    const items = found.filter((x) => x !== null).sort((a, b) => a.packageName.localeCompare(b.packageName));
    return { items, total: items.length };
  }

  @Post('releases')
  register(@Body() body: ReleaseRequest) {
    if (!body || !['create', 'upgrade'].includes(body.intent))
      throw new BadRequestException('发布意图应为 create 或 upgrade');
    const pending = this.publication.then(() => this.publish(body));
    this.publication = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async publish(body: ReleaseRequest) {
    let packageName = body.packageName;
    let id: string, version: string;
    const draft = body.template === 'codex-text' ? templateDeclaration(body) : undefined;
    if (draft) {
      if (packageName) throw new BadRequestException('请选择模板或已部署的包');
      ({ agentId: id, version } = draft);
    } else {
      if (body.template !== undefined || typeof packageName !== 'string' || !packageKey.test(packageName))
        throw new BadRequestException('请选择有效的包目录');
      let pkg;
      try {
        pkg = await declaredPackage(this.root, packageName);
      } catch {
        throw new NotFoundException('指定包不存在或声明无效');
      }
      id = pkg.manifest.agentId;
      version = pkg.manifest.version;
      if (body.agentId !== undefined && body.agentId !== id)
        throw new BadRequestException('包的智能体标识与所选智能体不一致');
    }
    const history = (await this.registry.list(true)).filter((r) => r.agentId === id);
    if (history.some(r=>r.status==='deleting')) throw new ConflictException({code:'agent_busy',message:'当前智能体正在删除。'});
    const retired = history.filter(r=>r.status==='deleted');
    if (retired.some(r=>!newer(version,r.version))) throw new ConflictException('历史版本已删除，请发布严格高于所有已删除版本的新版本。');
    const versions = history.filter(r=>r.status!=='deleted');
    const same = versions.find((r) => r.version === version);
    // Manual registration may follow the directory watcher. Report the existing version without rerunning checks.
    if (same && !draft) return { agentId: id, version, status: same.status };
    if (same) throw new ConflictException('该版本已登记，请选择新版本号');
    if (body.intent === 'create' && versions.length)
      throw new ConflictException('该智能体已存在，请使用升级');
    if (body.intent === 'upgrade' && (!versions.length || versions.some((r) => !newer(version, r.version))))
      throw new ConflictException('升级需选择已有智能体，并发布更高版本');
    if (draft) packageName = await publishTextPackage(this.root, draft);
    const record = await this.registry.discover(join(this.root, packageName!), 'admin', body.intent==='create' && retired.length>0 && !versions.length);
    return { agentId: record.agentId, version: record.version, status: record.status };
  }

  @Get('agents/:agentId/status')
  status(@Param('agentId') id: string) { return this.registry.status(id); }

  @Post('agents/:agentId/delete') @HttpCode(200)
  delete(@Param('agentId') id: string) { return this.registry.deleteAgent(id); }

  @Post('agents/:agentId/versions/:version/offline')
  offline(@Param('agentId') id: string, @Param('version') version: string) {
    return this.registry.offline(id, version);
  }
}
