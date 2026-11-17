import type { AgentEvent, AgentResult, TaskEnvelope } from '../../agent-protocol/src/index.js';

export interface AgentReporter {
  report(event: AgentEvent): Promise<void>;
}

/** Posts ordered lifecycle events to the control plane for one leased attempt. */
export class HttpAgentReporter implements AgentReporter {
  public constructor(private readonly callbackUrl: string, private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  public async report(event: AgentEvent): Promise<void> {
    const response = await this.fetchImpl(this.callbackUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`Control-plane event callback failed with HTTP ${response.status}.`);
  }
}

/** Keeps result transport separate from the portable AgentResult protocol body. */
export class HttpResultReporter {
  public constructor(private readonly callbackUrl: string, private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  public async report(leaseToken: string, result: AgentResult): Promise<void> {
    const response = await this.fetchImpl(this.callbackUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseToken, result }),
    });
    if (!response.ok) throw new Error(`Control-plane result callback failed with HTTP ${response.status}.`);
  }
}

export function createEvent(envelope: TaskEnvelope, sequence: number, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    protocolVersion: 'v1', taskId: envelope.taskId, taskNodeId: envelope.taskNodeId, instanceId: envelope.instanceId,
    leaseToken: envelope.leaseToken, sequence, type, payload,
  };
}
