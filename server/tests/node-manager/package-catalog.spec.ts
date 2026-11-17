import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PackageCatalogService } from '../../apps/node-manager/src/catalog/package-catalog.service';

describe('package catalog self-check inspection', () => {
  it('uses the package-local TypeScript launcher for the RAGFlow self-check', async () => {
    const packagePath = join(process.cwd(), 'agents', 'ragflow-knowledge-v1.0.1');
    const spec = await new PackageCatalogService().inspectSelfCheck(packagePath);

    expect(spec).toMatchObject({
      agentId: 'ragflow-knowledge',
      version: '1.0.1',
      command: [join(process.cwd(), 'node_modules', '.bin', 'tsx'), 'src/self-check.ts'],
    });
  });

  it('resolves an approved relative executable to an absolute path for systemd-run', async () => {
    const packagePath = await mkdtemp(join(tmpdir(), 'agent-package-'));
    await mkdir(join(packagePath, 'schemas'));
    await writeFile(join(packagePath, 'agent.yaml'), 'protocolVersion: v1\nagentId: demo\ndisplayName: Demo\nversion: 1.0.0\nruntime: native\nselfCheckCommand: ./bin/check src/self-check.ts\ncapabilities:\n  - name: demo.run\n');
    const spec = await new PackageCatalogService().inspectSelfCheck(packagePath);
    expect(spec.command).toEqual([join(packagePath, 'bin', 'check'), 'src/self-check.ts']);
  });

  it('persists ready launch records and restores them after a node-manager restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-catalog-'));
    const statePath = join(root, 'ready-catalog.json');
    const packagePath = join(root, 'agents', 'ppt-maker');
    const nextPackagePath = join(root, 'agents', 'ppt-maker-v2');
    const catalog = new PackageCatalogService({ statePath });
    await catalog.upsertReady({ agentId: 'ppt-maker', version: '1.0.1', packagePath, entryCommand: ['../../node_modules/.bin/tsx', 'src/main.ts'] });
    await catalog.upsertReady({ agentId: 'ppt-maker', version: '1.0.2', packagePath: nextPackagePath, entryCommand: ['../../node_modules/.bin/tsx', 'src/main.ts'] });

    const restarted = new PackageCatalogService({ statePath });
    await restarted.load();

    await expect(restarted.find('ppt-maker', '1.0.1')).resolves.toMatchObject({ status: 'ready', packagePath, entryCommand: [join(root, 'node_modules', '.bin', 'tsx'), join(packagePath, 'src', 'main.ts')] });
    await expect(restarted.find('ppt-maker', '1.0.2')).resolves.toMatchObject({ status: 'ready', packagePath: nextPackagePath });
    await restarted.revoke('ppt-maker','1.0.1');
    const afterRevoke = new PackageCatalogService({ statePath });
    await afterRevoke.load();
    expect(await afterRevoke.find('ppt-maker','1.0.1')).toBeUndefined();
    expect(await afterRevoke.find('ppt-maker','1.0.2')).toBeDefined();
  });
});
