import type { Static, TSchema } from '@sinclair/typebox';

import type { AgentCallNodeSchema, HumanInteractionNodeSchema, TaskPlanNodeSchema } from './schemas.js';

/** A reviewed and ready capability, supplied by the control-plane registry. */
export interface ReadyCapability {
  agentId: string;
  version: string;
  capability: string;
  displayName?: string;
  description?: string;
  runtime?: 'codex' | 'pi' | 'native';
  entryCommand?: string[];
  inputSchema: TSchema;
  resultSchema: TSchema;
}

export type CompiledAgentCallNode = Static<typeof AgentCallNodeSchema> & {
  agentId: string;
  agentVersion: string;
};

export type CompiledHumanInteractionNode = Static<typeof HumanInteractionNodeSchema>;

export type CompiledTaskPlan = {
  version: 'v1';
  nodes: Array<Static<typeof TaskPlanNodeSchema> | CompiledAgentCallNode>;
};

export class TaskPlanValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TaskPlanValidationError';
  }
}
