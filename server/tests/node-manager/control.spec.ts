import { describe, expect, it, vi } from 'vitest';

import { ControlService } from '../../apps/node-manager/src/control/control.service';

describe('node manager control service', () => {
  it('refuses unapproved versions and starts only a ready package entry point', async () => {
    const start = vi.fn().mockResolvedValue({ instanceId: 'instance-1', unitName: 'mg-agent-instance-1' });
    const catalog = { find: vi.fn().mockResolvedValue({ status: 'pending_review', entryCommand: ['tsx', 'src/main.ts'] }), upsertReady: vi.fn() };
    const service = new ControlService({
      catalog,
      supervisor: { start, stop: vi.fn() },
    });
    await expect(service.startInstance({ instanceId: 'instance-1', agentId: 'ragflow-knowledge', version: '1.0.0', workspacePath: '/tmp/work', environmentFile: '/tmp/env', envelopePath: '/tmp/work/envelope.json' })).rejects.toThrow(/ready/i);

    catalog.find = vi.fn().mockResolvedValue({ status: 'ready', entryCommand: ['tsx', 'src/main.ts'] });
    await service.startInstance({ instanceId: 'instance-1', agentId: 'ragflow-knowledge', version: '1.0.0', workspacePath: '/tmp/work', environmentFile: '/tmp/env', envelopePath: '/tmp/work/envelope.json', command: ['rm', '-rf', '/'] } as never);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ command: ['tsx', 'src/main.ts'], workingDirectory: '/tmp/work' }));
  });

  it('upserts only ready versions into the launch catalog', async () => {
    const upsertReady = vi.fn().mockResolvedValue(undefined);
    const service = new ControlService({ catalog: { find: vi.fn(), upsertReady }, supervisor: { start: vi.fn(), stop: vi.fn() } });

    await service.syncReadyVersion({ agentId: 'ppt-maker', version: '1.0.1', packagePath: '/agents/ppt-maker', entryCommand: ['tsx', 'src/main.ts'] });

    expect(upsertReady).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ppt-maker', version: '1.0.1' }));
  });

  it('runs a self-check only when the static manifest matches the approved identity', async () => {
    const selfCheck = vi.fn().mockResolvedValue(undefined);
    const service = new ControlService({
      catalog: { find: vi.fn(), upsertReady: vi.fn() }, supervisor: { start: vi.fn(), stop: vi.fn() },
      selfCheckCatalog: { inspectSelfCheck: vi.fn().mockResolvedValue({ agentId: 'ragflow-knowledge', version: '1.0.0', packagePath: '/agents/ragflow-knowledge', command: ['tsx', 'src/self-check.ts'] }) },
      selfCheckSupervisor: { selfCheck },
    });
    await service.requestSelfCheck({ agentId: 'ragflow-knowledge', version: '1.0.0', packagePath: '/agents/ragflow-knowledge' });
    expect(selfCheck).toHaveBeenCalledWith(expect.objectContaining({ command: ['tsx', 'src/self-check.ts'] }));
  });
});
