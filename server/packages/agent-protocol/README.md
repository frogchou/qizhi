# Agent Protocol v1

This package is the language-neutral contract between the control plane, node
manager and independently deployed agent services.  Its JSON Schema artifacts
are generated into `generated/` and contain no runtime-specific Codex or Pi
configuration.

## Contract messages

- `AgentManifest`: static, untrusted package declaration read before approval.
  It identifies an agent version and its named capabilities, but cannot start
  the package.
- `TaskEnvelope`: a leased invocation.  `taskId`, `taskNodeId`, `instanceId`,
  `attemptNumber` and `leaseToken` make callbacks attributable and rejectable.
- `TaskPlan`: a planner proposal made of `agent_call`, `condition`, `approval`
  and `end` nodes.  It is not executable until compiled against ready
  capabilities.
- `AgentEvent`: ordered lifecycle callback.  `(instanceId, sequence)` is
  persisted uniquely by the control plane.
- `AgentResult`: terminal output, cited evidence, risks, and artifact hashes.
- `ControlCommand`: node-manager-only launch, stop, or recovery instruction.

## Compiler boundary

`validateTaskPlan` receives untrusted planner JSON and the control plane's
reviewed ready-capability catalog. It rejects malformed graphs, unknown
capabilities, invalid agent-call input, duplicate or cyclic dependencies, and
shared workspaces without an explicit `sharingGroup`. Every accepted graph has
exactly one terminal `end` node, and every non-end node must feed that terminal
node, so a task cannot be marked complete while a disconnected branch remains.
For each admitted agent
node it binds the exact reviewed `agentId` and `agentVersion`; planners do not
choose executable binaries directly.

Run `corepack pnpm protocol:export` after a schema change. Generated schemas
are the portable contract for future non-TypeScript agents.

## User-facing delivery content

Use `AgentResult.output.answer` for the complete Markdown answer, or `output.text`
for legacy textual results. A short `output.summary` is an execution overview and
must not replace the requested substantive content. Never treat `passed: true`
or an artifact-generation acknowledgement as the user's requested answer.

All files must still appear in `artifacts` with their actual path and SHA-256.
Optional `output.deliveryArtifactPaths: string[]` identifies the subset intended
as deliverables; other declared files remain available as supporting records.
This convention uses the existing open output object, so no wire-schema or
protocol-version change is required. The control plane validates and archives
artifacts as before. See the task module's `DELIVERY_CONTENT.md` for the projection.
