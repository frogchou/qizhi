import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Value } from '@sinclair/typebox/value';

import { AgentManifestSchema, type AgentManifest } from '../../../../packages/agent-protocol/src/index.js';

export type PackageRecord = { status: 'ready'; entryCommand: string[]; packagePath: string };
export type ReadyPackageRecord = { agentId: string; version: string; packagePath: string; entryCommand: string[] };
export type SelfCheckSpec = { agentId: string; version: string; packagePath: string; command: string[] };

export interface PackageCatalog {
  revoke?(agentId:string,version:string):Promise<void>;
  find(agentId: string, version: string): Promise<PackageRecord | undefined>;
  upsertReady(record: ReadyPackageRecord): Promise<void>;
}

/** First-release catalog seam. Task 6 registry is the authority; HTTP wiring follows in the node-manager API. */
export class PackageCatalogService implements PackageCatalog {
  private readonly records = new Map<string, PackageRecord>();
  private writes:Promise<void>=Promise.resolve();
  private readonly statePath: string;
  public constructor(input: { statePath?: string } = {}) { this.statePath = input.statePath ?? '/home/middleground/data/node-manager/ready-catalog.json'; }
  public async find(agentId: string, version: string): Promise<PackageRecord | undefined> { return this.records.get(`${agentId}@${version}`); }
  public async upsertReady(record: ReadyPackageRecord): Promise<void> {
    if (!record.entryCommand.length) throw new Error('Ready package command must not be empty.');
    this.records.set(`${record.agentId}@${record.version}`, { status: 'ready', packagePath: record.packagePath, entryCommand: resolveCommand(record.packagePath, record.entryCommand) });
    await this.persist();
  }

  public async load(): Promise<void> {
    try {
      const records = JSON.parse(await readFile(this.statePath, 'utf8')) as ReadyPackageRecord[];
      for (const record of records) this.records.set(`${record.agentId}@${record.version}`, { status: 'ready', packagePath: record.packagePath, entryCommand: record.entryCommand });
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  public async revoke(agentId:string,version:string) {
    this.records.delete(`${agentId}@${version}`);
    await this.persist();
  }

  /** Called only after control-plane approval; reads the declared command without importing package code. */
  public async inspectSelfCheck(packagePath: string): Promise<SelfCheckSpec> {
    const manifest = await this.readManifest(packagePath);
    if (!manifest.selfCheckCommand) throw new Error('Approved agent manifest has no self-check command.');
    const command = manifest.selfCheckCommand.trim().split(/\s+/);
    if (command.length === 0 || command.some((part) => !part)) throw new Error('Invalid self-check command.');
    // systemd-run does not resolve a relative executable against
    // --working-directory. Resolve a reviewed relative command before launch.
    if (command[0].startsWith('.')) command[0] = resolve(packagePath, command[0]);
    return { agentId: manifest.agentId, version: manifest.version, packagePath, command };
  }

  private async readManifest(packagePath: string): Promise<AgentManifest> {
    const manifest = parse(await readFile(join(packagePath, 'agent.yaml'), 'utf8'));
    if (!Value.Check(AgentManifestSchema, manifest)) throw new Error('Agent manifest does not match Agent Protocol v1.');
    return manifest;
  }

  private async persist(): Promise<void> {
    const records = [...this.records.entries()].map(([key, value]) => {
      const [agentId, version] = key.split('@', 2);
      return { agentId, version, packagePath: value.packagePath, entryCommand: value.entryCommand };
    });
    const write=async()=>{
      await mkdir(dirname(this.statePath), { recursive:true });
      const temp=this.statePath+'.next';
      await writeFile(temp,JSON.stringify(records,null,2)+'\n',{mode:0o600});
      await rename(temp,this.statePath);
    };
    this.writes=this.writes.then(write,write);
    await this.writes;
  }
}

function resolveCommand(packagePath: string, command: string[]): string[] {
  return command.map((part, index) => index === 0 || part.includes('/') || part.includes('\\') ? resolve(packagePath, part) : part);
}

function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'; }
