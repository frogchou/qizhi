import { describe, expect, it, vi } from 'vitest';

import { SystemdSupervisor } from '../../apps/node-manager/src/supervisor/systemd.supervisor';

describe('SystemdSupervisor', () => {
  it('starts an instance in a deterministic transient unit with its own workspace', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const supervisor = new SystemdSupervisor({ run });

    const started = await supervisor.start({ instanceId: 'instance-1', workingDirectory: '/home/middleground/data/workspaces/task-1', environmentFile: '/run/mg/instance-1.env', command: ['tsx', 'src/main.ts'] });

    expect(started).toEqual({ instanceId: 'instance-1', unitName: 'mg-agent-instance-1' });
    expect(run).toHaveBeenCalledWith('systemd-run', expect.arrayContaining(['--unit=mg-agent-instance-1', '--working-directory=/home/middleground/data/workspaces/task-1', '--property=EnvironmentFile=/run/mg/instance-1.env', 'tsx', 'src/main.ts']));
  });

  it('stops idempotently using the same deterministic unit name', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const supervisor = new SystemdSupervisor({ run });
    await supervisor.stop('instance-1');
    expect(run).toHaveBeenCalledWith('systemctl', ['stop', 'mg-agent-instance-1']);
  });
});
