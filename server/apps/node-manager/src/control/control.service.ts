import type { PackageCatalog, ReadyPackageRecord, SelfCheckSpec } from '../catalog/package-catalog.service.js';
import type { ProcessSupervisor, SelfCheckSupervisor, StartedInstance } from '../supervisor/supervisor.js';

export type StartInstanceRequest = { instanceId: string; agentId: string; version: string; workspacePath: string; environmentFile: string; envelopePath: string };

export class ControlService {
  public constructor(private readonly dependencies: { catalog: PackageCatalog; supervisor: ProcessSupervisor; selfCheckCatalog?: { inspectSelfCheck(packagePath: string): Promise<SelfCheckSpec> }; selfCheckSupervisor?: SelfCheckSupervisor }) {}

  public async startInstance(request: StartInstanceRequest): Promise<StartedInstance> {
    const record = await this.dependencies.catalog.find(request.agentId, request.version);
    if (!record || record.status !== 'ready') throw new Error('Only ready agent versions may be started.');
    try {
      const started = await this.dependencies.supervisor.start({ instanceId: request.instanceId, workingDirectory: request.workspacePath, environmentFile: request.environmentFile, command: record.entryCommand });
      this.log('instance_launch_accepted', { instanceId: request.instanceId, agentId: request.agentId, version: request.version, unitName: started.unitName });
      return started;
    } catch (error) {
      this.log('instance_launch_failed', { instanceId: request.instanceId, agentId: request.agentId, version: request.version, message: publicMessage(error) });
      throw error;
    }
  }

  public async syncReadyVersion(record: ReadyPackageRecord): Promise<void> { await this.dependencies.catalog.upsertReady(record); }

  public async revokeVersion(agentId:string,version:string) {
    if(!this.dependencies.catalog.revoke)throw new Error('Catalog does not support revoke');
    await this.dependencies.catalog.revoke(agentId,version);
  }

  public async stopInstance(instanceId: string): Promise<void> {
    await this.dependencies.supervisor.stop(instanceId);
    this.log('instance_stop_requested', { instanceId });
  }

  public async requestSelfCheck(input: { agentId: string; version: string; packagePath: string }): Promise<void> {
    if (!this.dependencies.selfCheckCatalog || !this.dependencies.selfCheckSupervisor) throw new Error('Self-check is not configured.');
    const spec = await this.dependencies.selfCheckCatalog.inspectSelfCheck(input.packagePath);
    if (spec.agentId !== input.agentId || spec.version !== input.version) throw new Error('Self-check manifest identity does not match approved version.');
    await this.dependencies.selfCheckSupervisor.selfCheck(spec);
  }

  private log(event: string, detail: Record<string, unknown>): void {
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', component: 'node_manager', event, detail }));
  }
}

function publicMessage(error: unknown): string { return (error instanceof Error ? error.message : 'unknown error').replace(/\s+/g, ' ').slice(0, 500); }
