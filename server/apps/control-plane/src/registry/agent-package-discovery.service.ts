import { existsSync, type FSWatcher, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

type AgentRegistrar = {
  discover(packagePath: string, actor?: string): Promise<unknown>;
  recordDiscoveryFailure?(packagePath: string, reason: string): Promise<void>;
};

export type DiscoveryResult = {
  packagePath: string;
  outcome: 'discovered' | 'failed' | 'skipped';
  agentId?: string;
  version?: string;
  status?: string;
  reason?: string;
};

/** Reads declaration-only agent packages placed in the shared agent directory. */
export class AgentPackageDiscoveryService {
  private watcher: FSWatcher | undefined;
  private pendingScan: NodeJS.Timeout | undefined;

  public constructor(private readonly registry: AgentRegistrar, private readonly config: { root: string }) {}

  public async discoverAvailable(): Promise<DiscoveryResult[]> {
    const entries = await readdir(this.config.root, { withFileTypes: true });
    const discovered: DiscoveryResult[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const packagePath = join(this.config.root, entry.name);
      if (!existsSync(join(packagePath, 'agent.yaml'))) continue;
      try {
        const result = object(await this.registry.discover(packagePath, 'system'));
        discovered.push({
          packagePath,
          outcome: ['deleted','deleting'].includes(String(result.status)) ? 'skipped' : 'discovered',
          agentId: text(result.agentId),
          version: text(result.version),
          status: text(result.status),
        });
      } catch (error) {
        const reason = publicMessage(error);
        try { await this.registry.recordDiscoveryFailure?.(packagePath, reason); } catch { /* discovery continues even if audit storage is unavailable */ }
        discovered.push({ packagePath, outcome: 'failed', reason });
      }
    }
    return discovered;
  }

  /** Watches only directory metadata; each scan still reads declarations and never executes agent code. */
  public startWatching(): void {
    if (this.watcher) return;
    this.watcher = watch(this.config.root, { persistent: false }, () => this.scheduleScan());
  }

  public stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pendingScan) clearTimeout(this.pendingScan);
    this.pendingScan = undefined;
  }

  private scheduleScan(): void {
    if (this.pendingScan) return;
    this.pendingScan = setTimeout(() => {
      this.pendingScan = undefined;
      void this.discoverAvailable().catch(() => undefined);
    }, 250);
    this.pendingScan.unref();
  }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function publicMessage(error: unknown): string { return (error instanceof Error ? error.message : 'unknown discovery error').replace(/\s+/g, ' ').slice(0, 1_000); }
