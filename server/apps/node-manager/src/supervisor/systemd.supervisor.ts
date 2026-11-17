import { spawn } from 'node:child_process';

import type { InstanceLaunchSpec, ProcessSupervisor, SelfCheckSupervisor, StartedInstance } from './supervisor.js';

export interface CommandRunner { run(command: string, args: string[]): Promise<void>; }

export class SystemdSupervisor implements ProcessSupervisor, SelfCheckSupervisor {
  public constructor(private readonly runner: CommandRunner = { run: runCommand }) {}

  public async start(spec: InstanceLaunchSpec): Promise<StartedInstance> {
    const unitName = unitFor(spec.instanceId);
    if (spec.command.length === 0) throw new Error('Agent command must not be empty.');
    await this.runner.run('systemd-run', [
      '--no-block',
      `--unit=${unitName}`,
      `--working-directory=${spec.workingDirectory}`,
      `--property=EnvironmentFile=${spec.environmentFile}`,
      ...spec.command,
    ]);
    return { instanceId: spec.instanceId, unitName };
  }

  public async stop(instanceId: string): Promise<void> {
    await this.runner.run('systemctl', ['stop', unitFor(instanceId)]);
  }

  public async selfCheck(spec: { agentId: string; version: string; packagePath: string; command: string[] }): Promise<void> {
    const suffix = `${spec.agentId}-${spec.version}`.replace(/[^A-Za-z0-9-]/g, '-');
    await this.runner.run('systemd-run', ['--wait', '--collect', `--unit=mg-self-check-${suffix}`, `--working-directory=${spec.packagePath}`, ...spec.command]);
  }
}

export function unitFor(instanceId: string): string {
  if (!/^[A-Za-z0-9-]{1,120}$/.test(instanceId)) throw new Error('Instance ID contains unsupported characters.');
  return `mg-agent-${instanceId}`;
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      // systemctl stop returns EXIT_NOTINSTALLED (5) for an unloaded transient unit.
      if (code === 0 || (command === 'systemctl' && args[0] === 'stop' && code === 5)) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`));
    });
  });
}
