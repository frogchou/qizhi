import { Type, type Static } from '@sinclair/typebox';

const Identifier = Type.String({ minLength: 1, maxLength: 160 });
const JsonValue = Type.Unknown();

export const CapabilityDeclarationSchema = Type.Object({
  name: Identifier,
  description: Type.Optional(Type.String({ maxLength: 2_000 })),
});

export const AgentManifestSchema = Type.Object({
  protocolVersion: Type.Literal('v1'),
  agentId: Identifier,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$' }),
  capabilities: Type.Array(CapabilityDeclarationSchema, { minItems: 1 }),
  runtime: Type.Optional(Type.Union([Type.Literal('codex'), Type.Literal('pi'), Type.Literal('native')])),
  entryCommand: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1 })),
  selfCheckCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });

export const WorkspaceSchema = Type.Object({
  mode: Type.Union([Type.Literal('isolated'), Type.Literal('shared')]),
  sharingGroup: Type.Optional(Identifier),
}, { additionalProperties: false });

const PlanNodeBaseSchema = Type.Object({
  id: Identifier,
  dependsOn: Type.Optional(Type.Array(Identifier, { uniqueItems: true })),
});

const InteractionTarget = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,159}$' });
const InteractionScalarSchema = Type.Union([
  Type.Literal('string'),
  Type.Literal('number'),
  Type.Literal('boolean'),
]);
const InteractionResponsePropertySchema = Type.Object({
  type: Type.Union([InteractionScalarSchema, Type.Literal('array')]),
  enum: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 50, uniqueItems: true })),
  minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_000 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_000 })),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  items: Type.Optional(Type.Object({ type: InteractionScalarSchema }, { additionalProperties: false })),
}, { additionalProperties: false });

export const InteractionResponseSchema = Type.Object({
  type: Type.Literal('object'),
  properties: Type.Record(Identifier, InteractionResponsePropertySchema, { minProperties: 1, maxProperties: 30 }),
  required: Type.Optional(Type.Array(Identifier, { uniqueItems: true, maxItems: 30 })),
  additionalProperties: Type.Literal(false),
}, { additionalProperties: false });

export const InteractionRequestSchema = Type.Object({
  kind: Type.Union([Type.Literal('confirmation'), Type.Literal('clarification'), Type.Literal('form')]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  prompt: Type.String({ minLength: 1, maxLength: 4_000 }),
  responseSchema: InteractionResponseSchema,
  responseTarget: InteractionTarget,
}, { additionalProperties: false });

export const AgentCallNodeSchema = Type.Composite([
  PlanNodeBaseSchema,
  Type.Object({
    type: Type.Literal('agent_call'),
    capability: Identifier,
    input: Type.Record(Type.String(), JsonValue),
    inputBindings: Type.Optional(Type.Array(Type.Object({
      target: Identifier,
      fromNode: Identifier,
      source: Type.Union([Type.Literal('evidence'), Type.Literal('artifact')]),
      artifactPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
      format: Type.Union([Type.Literal('evidence_markdown'), Type.Literal('artifact_paths')]),
    }, { additionalProperties: false }))),
    taskInputBindings: Type.Optional(Type.Array(Type.Object({
      target: Identifier,
      inputId: Identifier,
      format: Type.Literal('task_input_paths'),
    }, { additionalProperties: false }))),
    workspace: WorkspaceSchema,
  }),
], { additionalProperties: false });

export const ConditionNodeSchema = Type.Composite([
  PlanNodeBaseSchema,
  Type.Object({
    type: Type.Literal('condition'),
    expression: Type.String({ minLength: 1, maxLength: 2_000 }),
  }),
]);

export const ApprovalNodeSchema = Type.Composite([
  PlanNodeBaseSchema,
  Type.Object({
    type: Type.Literal('approval'),
    reason: Type.String({ minLength: 1, maxLength: 2_000 }),
  }),
]);

export const HumanInteractionNodeSchema = Type.Composite([
  PlanNodeBaseSchema,
  Type.Object({
    type: Type.Literal('human_interaction'),
    interaction: InteractionRequestSchema,
  }),
], { additionalProperties: false });

export const EndNodeSchema = Type.Composite([
  PlanNodeBaseSchema,
  Type.Object({ type: Type.Literal('end') }),
]);

export const TaskPlanNodeSchema = Type.Union([
  AgentCallNodeSchema,
  ConditionNodeSchema,
  ApprovalNodeSchema,
  HumanInteractionNodeSchema,
  EndNodeSchema,
]);

export const TaskPlanSchema = Type.Object({
  version: Type.Literal('v1'),
  nodes: Type.Array(TaskPlanNodeSchema, { minItems: 1 }),
}, { additionalProperties: false });

export const InteractionCheckpointSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  resumeKey: Identifier,
  workspaceRelativePath: Type.String({ minLength: 1, maxLength: 2_000 }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
}, { additionalProperties: false });

export const TaskResumeSchema = Type.Object({
  fromInteractionId: Identifier,
  checkpoint: InteractionCheckpointSchema,
  answers: Type.Array(Type.Object({
    interactionId: Identifier,
    response: Type.Record(Type.String(), JsonValue),
  }, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false });

export const TaskEnvelopeSchema = Type.Object({
  protocolVersion: Type.Literal('v1'),
  taskId: Identifier,
  taskNodeId: Identifier,
  instanceId: Identifier,
  attemptNumber: Type.Integer({ minimum: 1 }),
  leaseToken: Type.String({ minLength: 24 }),
  workspacePath: Type.String({ minLength: 1 }),
  taskRoot: Type.Optional(Type.String({ minLength: 1 })),
  nodeWorkspacePath: Type.Optional(Type.String({ minLength: 1 })),
  sharingGroup: Type.Optional(Identifier),
  input: Type.Record(Type.String(), JsonValue),
  /** Task-private materials explicitly granted to this node, with node-relative paths only. */
  taskInputs: Type.Optional(Type.Array(Type.Object({
    id: Identifier,
    displayName: Type.String({ minLength: 1, maxLength: 255 }),
    sourceType: Identifier,
    mediaType: Type.String({ minLength: 1, maxLength: 255 }),
    sizeBytes: Type.Integer({ minimum: 1 }),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    path: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false }))),
  // Node agents call a control-plane address that can legitimately be a
  // loopback IP. TypeBox's URI format rejects that operationally valid form;
  // the scheduler, not agent-supplied data, owns the callback address.
  callback: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2_000 }) }, { additionalProperties: false }),
  resultCallback: Type.Optional(Type.Object({ url: Type.String({ minLength: 1, maxLength: 2_000 }) }, { additionalProperties: false })),
  // JavaScript's ISO serialisation includes milliseconds.  TypeBox's
  // built-in `date-time` format rejects that valid RFC 3339 form in some
  // runtime versions, so semantic date validation belongs to the shared
  // runtime after the envelope shape has been checked.
  deadlineAt: Type.Optional(Type.String({ minLength: 20, maxLength: 64 })),
  checkpointRef: Type.Optional(Identifier),
  resume: Type.Optional(TaskResumeSchema),
}, { additionalProperties: false });

export const EvidenceSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  datasetId: Type.Optional(Identifier),
  documentId: Type.Optional(Identifier),
  title: Type.Optional(Type.String()),
  excerpt: Type.String(),
  similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
}, { additionalProperties: false });

const AgentResultIdentitySchema = Type.Object({
  protocolVersion: Type.Literal('v1'),
  taskId: Identifier,
  taskNodeId: Identifier,
  instanceId: Identifier,
}, { additionalProperties: false });

const AgentTerminalResultSchema = Type.Composite([AgentResultIdentitySchema, Type.Object({
  status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
  output: Type.Record(Type.String(), JsonValue),
  evidence: Type.Array(EvidenceSchema),
  risks: Type.Array(Type.String()),
  artifacts: Type.Array(Type.Object({ path: Type.String(), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) })),
}, { additionalProperties: false })], { additionalProperties: false });

export const AgentNeedsUserInputResultSchema = Type.Composite([AgentResultIdentitySchema, Type.Object({
  status: Type.Literal('needs_user_input'),
  summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  interaction: InteractionRequestSchema,
  checkpoint: InteractionCheckpointSchema,
}, { additionalProperties: false })], { additionalProperties: false });

export const AgentResultSchema = Type.Union([AgentTerminalResultSchema, AgentNeedsUserInputResultSchema]);

export const AgentEventSchema = Type.Object({
  protocolVersion: Type.Literal('v1'),
  taskId: Identifier,
  taskNodeId: Identifier,
  instanceId: Identifier,
  leaseToken: Type.String({ minLength: 24 }),
  sequence: Type.Integer({ minimum: 1 }),
  type: Type.Union([
    Type.Literal('started'),
    Type.Literal('progress'),
    Type.Literal('checkpoint'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('heartbeat'),
    Type.Literal('output'),
  ]),
  payload: Type.Record(Type.String(), JsonValue),
}, { additionalProperties: false });

export const ControlCommandSchema = Type.Object({
  protocolVersion: Type.Literal('v1'),
  commandId: Identifier,
  type: Type.Union([Type.Literal('launch'), Type.Literal('stop'), Type.Literal('recover')]),
  instanceId: Identifier,
  leaseToken: Type.Optional(Type.String({ minLength: 24 })),
  envelope: Type.Optional(TaskEnvelopeSchema),
}, { additionalProperties: false });

export type AgentManifest = Static<typeof AgentManifestSchema>;
export type TaskEnvelope = Static<typeof TaskEnvelopeSchema>;
export type TaskPlan = Static<typeof TaskPlanSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type AgentResult = Static<typeof AgentResultSchema>;
export type AgentTerminalResult = Static<typeof AgentTerminalResultSchema>;
export type ControlCommand = Static<typeof ControlCommandSchema>;
export type Evidence = Static<typeof EvidenceSchema>;
export type InteractionRequest = Static<typeof InteractionRequestSchema>;
export type InteractionCheckpoint = Static<typeof InteractionCheckpointSchema>;
export type TaskResume = Static<typeof TaskResumeSchema>;
