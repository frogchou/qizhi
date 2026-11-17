import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { AgentPackageDiscoveryService } from '../../apps/control-plane/src/registry/agent-package-discovery.service';

describe('agent package discovery', () => {
  it('reads only top-level declaration directories and registers them as pending review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-directory-'));
    const agentRoot = join(root, 'ppt-maker');
    await mkdir(agentRoot);
    await writeFile(join(agentRoot, 'agent.yaml'), 'protocolVersion: v1\n');
    await mkdir(join(root, 'not-an-agent'));
    await writeFile(join(root, 'README.md'), 'not a package');
    const registry = { discover: vi.fn().mockResolvedValue({ status: 'pending_review' }) };

    const service = new AgentPackageDiscoveryService(registry, { root });
    await service.discoverAvailable();

    expect(registry.discover).toHaveBeenCalledTimes(1);
    expect(registry.discover).toHaveBeenCalledWith(agentRoot, 'system');
  });

  it('records one malformed package but continues to discover every other package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-directory-'));
    const malformed = join(root, 'broken-agent');
    const ready = join(root, 'quality-management');
    await mkdir(malformed);
    await mkdir(ready);
    await Promise.all([
      writeFile(join(malformed, 'agent.yaml'), 'invalid: declaration'),
      writeFile(join(ready, 'agent.yaml'), 'protocolVersion: v1'),
    ]);
    const registry = {
      discover: vi.fn(async (path: string) => {
        if (path === malformed) throw new Error('manifest schema is invalid');
        return { agentId: 'quality-management', version: '1.0.1', status: 'pending_review' };
      }),
      recordDiscoveryFailure: vi.fn().mockResolvedValue(undefined),
    };

    const results = await new AgentPackageDiscoveryService(registry, { root }).discoverAvailable();

    expect(registry.discover).toHaveBeenCalledTimes(2);
    expect(registry.recordDiscoveryFailure).toHaveBeenCalledWith(malformed, 'manifest schema is invalid');
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ packagePath: malformed, outcome: 'failed', reason: 'manifest schema is invalid' }),
      expect.objectContaining({ packagePath: ready, outcome: 'discovered', agentId: 'quality-management', version: '1.0.1', status: 'pending_review' }),
    ]));
  });
});
