import type { NodeManagerClient } from './registry.service.js';

/** HTTP boundary used by the control plane after an administrator approves a package. */
export class HttpNodeManagerClient implements NodeManagerClient {
  public constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  public async requestSelfCheck(input: { agentId: string; version: string; packagePath: string }): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/v1/self-checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MG-Internal-Token': this.token },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Node manager self-check request failed with HTTP ${response.status}.`);
  }

  public async syncReadyVersion(input: { agentId: string; version: string; packagePath: string; entryCommand: string[] }): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/v1/catalog/ready-versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MG-Internal-Token': this.token }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Node manager ready-version sync failed with HTTP ${response.status}.`);
  }

  public async startInstance(input: { instanceId: string; agentId: string; version: string; workspacePath: string; environmentFile: string; envelopePath: string }): Promise<{ instanceId: string; unitName: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/v1/instances`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MG-Internal-Token': this.token }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Node manager instance start failed with HTTP ${response.status}.`);
    return response.json() as Promise<{ instanceId: string; unitName: string }>;
  }

  public async stopInstance(instanceId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/v1/instances/${encodeURIComponent(instanceId)}/stop`, {
      method: 'POST', headers: { 'X-MG-Internal-Token': this.token },
    });
    if (!response.ok) throw new Error(`Node manager instance stop failed with HTTP ${response.status}.`);
  }

  public async revokeVersion(agentId:string,version:string) {
    const response=await this.fetchImpl(`${this.baseUrl}/internal/v1/catalog/revoke`,{
      method:'POST',headers:{'Content-Type':'application/json','X-MG-Internal-Token':this.token},body:JSON.stringify({agentId,version}),signal:AbortSignal.timeout(10_000),
    });
    if(!response.ok)throw new Error(`节点管理服务移除就绪版本失败 (HTTP ${response.status})`);
  }
}
