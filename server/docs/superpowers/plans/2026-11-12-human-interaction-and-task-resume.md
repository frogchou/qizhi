# Human Interaction and Task Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, auditable human-interaction capability that pauses a task for confirmation or information, accepts a validated answer (and task-private attachments), then resumes only the affected task node.

**Architecture:** Extend Agent Protocol v1 with a compiled `human_interaction` plan node and a yielding `AgentResult` variant. Persist interaction requests, messages, checkpoints and node states in PostgreSQL and the task workspace; the scheduler, not a held Codex process, owns pause and resume. Reuse the current task activity/SSE stream and task-input staging path for live operator feedback and task-private reply attachments.

**Tech Stack:** TypeScript, NestJS/Fastify, TypeORM migrations with PostgreSQL, TypeBox, React 19/Vite, Vitest, SSE, systemd-backed node manager.

**Spec:** `docs/superpowers/specs/2026-11-12-human-interaction-and-task-resume-design.md`

## Global Constraints

- Implement `human_interaction` with `confirmation`, `clarification` and `form`; retain legacy `approval` as a compiler-normalized confirmation alias.
- The task state is `awaiting_user_input`; it is distinct from final-delivery `awaiting_review`.
- A paused interaction must persist a validated checkpoint and end/yield its active attempt; do not hold a Codex process, shell, lease or in-memory continuation while waiting.
- Only task-local, contained relative paths may enter checkpoints, envelopes or attachment records; never write tokens, API keys, passwords, secrets or arbitrary absolute paths to task files, activities or browser responses.
- Existing quality acceptance/rework, private initial inputs, artifact delivery, liveness recovery and ready-agent dispatch must retain their current behavior.
- A service restart must never autonomously resume an `awaiting_user_input` task; only a validated response may do that.
- The initial authority remains the existing fixed administrator token. Responses must be idempotent and auditable.
- This plan builds the platform capability only. Do not implement the agent-creator agent in this change.

## Review Focus

- A duplicate or concurrent answer to the same pending interaction must yield one durable answer and one resumed attempt only; pin this in Task 5's API test.
- A yielded old instance must not overwrite the resumed attempt with a late event/result; pin this in Task 4's internal result test.
- An interaction answer containing a traversal path, an unowned upload ID or a response outside its schema must be rejected without changing task state; pin this in Tasks 2 and 5.
- A process restart while a task is waiting must leave it paused and must not launch an instance; pin this in Task 6's recovery test.
- A plan with a legacy `approval` node must pause exactly like a confirmation interaction and unblock only its declared downstream nodes; pin this in Tasks 1 and 3.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/agent-protocol/src/schemas.ts` | TypeBox contracts for interaction plan nodes, constrained response schemas, resume envelopes and yielded results. |
| `packages/agent-protocol/src/compiler.ts` | Normalizes legacy approval nodes and validates interaction graph/static data. |
| `packages/agent-protocol/src/types.ts` | Exposes compiled interaction node types used by the scheduler. |
| `apps/control-plane/src/database/migrations/0006-task-interactions.ts` | Adds interaction, message and idempotency persistence plus task/node/attempt state support. |
| `apps/control-plane/src/tasks/task-interaction.service.ts` | Single owner for creation, validation, answer persistence, attachment freezing and resume claims. |
| `apps/control-plane/src/tasks/task-workspace.service.ts` | Creates contained interaction/checkpoint directories and writes immutable request/answer/message files. |
| `apps/control-plane/src/tasks/task-scheduler.service.ts` | Materializes interaction runtime nodes, pauses the graph, and launches the exact resumable agent node. |
| `apps/control-plane/src/internal/instance-results.service.ts` | Converts a valid `needs_user_input` result into a yielded attempt and durable interaction request. |
| `apps/control-plane/src/tasks/tasks.service.ts` / `tasks.controller.ts` | Returns interactions with task details and serves response/cancel endpoints. |
| `apps/control-plane/src/tasks/task-recovery.service.ts` / `task-monitor.ts` | Preserves waiting tasks through restart and projects the waiting phase. |
| `apps/control-plane/src/app.module.ts` | Wires the interaction service to scheduler, result service and task API. |
| `apps/console/src/lib/task-presenter.ts`, `apps/console/src/App.tsx`, `apps/console/src/task-interactions.css` | Presents pending questions, answer forms, reply attachments and live resume progress. |
| `tests/contracts/agent-protocol.spec.ts` | Protocol/compiler contract tests. |
| `tests/control-plane/task-interaction.service.spec.ts` | Persistence, workspace, schema validation and idempotency tests. |
| `tests/control-plane/task-scheduler.spec.ts` | Static plan-node pause/unblock and targeted dispatch tests. |
| `tests/control-plane/instance-results.e2e-spec.ts` | Yielded-result callback/late-callback safety tests. |
| `tests/control-plane/task-interactions.e2e-spec.ts` | Authenticated answer API and private attachment tests. |
| `tests/control-plane/task-recovery.spec.ts`, `tests/control-plane/task-monitor.spec.ts` | Restart and operator-state projections. |
| `tests/console/task-presenter.spec.ts`, `tests/console/workflow.spec.ts` | Browser presentation and interaction controls. |
| `apps/control-plane/src/tasks/README.md`, `apps/control-plane/src/database/README.md`, `docs/runbooks/control-console.md`, `docs/runbooks/agent-orchestration.md` | Operator and maintainer documentation. |

## Task 1: Define the Versioned Interaction Protocol

**Files:**
- Modify: `packages/agent-protocol/src/schemas.ts`
- Modify: `packages/agent-protocol/src/compiler.ts`
- Modify: `packages/agent-protocol/src/types.ts`
- Modify: `packages/agent-protocol/src/index.ts`
- Modify: `tests/contracts/agent-protocol.spec.ts`
- Generate: `packages/agent-protocol/generated/*.json`

**Interfaces:**
- Produces `HumanInteractionNodeSchema`, `InteractionRequestSchema`, `TaskResumeSchema`, `AgentNeedsUserInputResultSchema`, `TaskEnvelope.resume`, and `CompiledHumanInteractionNode`.
- Produces `normalizeTaskPlan(input: unknown): TaskPlan` called by `validateTaskPlan` before graph compilation.
- Consumed by Tasks 3 and 4; no control-plane code should invent a parallel JSON shape.

- [ ] **Step 1: Write protocol contract tests before implementation**

Add tests that assert all of the following:

```ts
expect(Value.Check(TaskPlanSchema, humanInteractionPlan)).toBe(true);
expect(validateTaskPlan(legacyApprovalPlan, catalog).nodes[0]).toMatchObject({
  type: 'human_interaction',
  interaction: { kind: 'confirmation' },
});
expect(Value.Check(AgentResultSchema, yieldedResult)).toBe(true);
expect(Value.Check(TaskEnvelopeSchema, resumeEnvelope)).toBe(true);
expect(Value.Check(TaskPlanSchema, oversizedOrUnknownInteractionField)).toBe(false);
```

The successful request must have `kind`, `title`, `prompt`, a bounded object `responseSchema`, and a logical `responseTarget`. Include plans proving a human node participates in terminal-DAG reachability and an invalid legacy approval reason fails cleanly.

- [ ] **Step 2: Run the protocol test to verify the new cases fail**

Run: `pnpm vitest run tests/contracts/agent-protocol.spec.ts`

Expected: FAIL because `human_interaction`, `needs_user_input`, or `resume` is not yet accepted.

- [ ] **Step 3: Implement the shared schemas and compiler normalization**

In `schemas.ts`, introduce a bounded response-schema model limited to object properties, scalar/array field definitions, `required`, `enum`, and length/count bounds. Define `human_interaction` with the exact properties in the spec and a strict `additionalProperties: false` contract. Keep `approval` readable at the protocol boundary but normalize it in `normalizeTaskPlan` to a confirmation request using its `reason` as the prompt.

Make `AgentResultSchema` a strict union of terminal success/failure and `needs_user_input`; the yielding branch must require `summary`, `interaction`, and a checkpoint `{ schemaVersion: 1, resumeKey, workspaceRelativePath, sha256 }`, while success/failure retain evidence/risk/artifact fields. Add optional `TaskEnvelope.resume` containing a contained checkpoint reference and ordered validated answers.

In `compiler.ts`, normalize before duplicate/dependency/end validation and reject interaction `responseTarget` values that resemble paths or contain control characters. Update the compiled node union/types without weakening reviewed-capability binding for `agent_call`.

- [ ] **Step 4: Regenerate portable schemas and run protocol tests**

Run: `pnpm protocol:export && pnpm vitest run tests/contracts/agent-protocol.spec.ts`

Expected: PASS; generated schemas match the updated TypeBox contract.

- [ ] **Step 5: Commit the protocol boundary**

```bash
git add packages/agent-protocol tests/contracts/agent-protocol.spec.ts
git commit -m "feat(protocol): add resumable human interaction contracts"
```

## Task 2: Add Durable Interaction Storage and Task-Local Evidence

**Files:**
- Create: `apps/control-plane/src/database/migrations/0006-task-interactions.ts`
- Create: `apps/control-plane/src/tasks/task-interaction.service.ts`
- Modify: `apps/control-plane/src/tasks/task-workspace.service.ts`
- Modify: `apps/control-plane/src/tasks/task-input.service.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Modify: `tests/control-plane/database-migration.spec.ts`
- Create: `tests/control-plane/task-interaction.service.spec.ts`

**Interfaces:**
- Consumes the interaction request/checkpoint types from Task 1 and existing `TaskInputService.stageUpload` / `freezeForTask` safeguards.
- Produces `TaskInteractionService.requestPlanInteraction(...)`, `requestAgentInteraction(...)`, `respond(...)`, `listForTask(...)`, `pendingForTask(...)`, and `resumeContextForNode(...)`.
- Produces `TaskWorkspaceService.writeInteractionRequest`, `appendInteractionMessage`, `writeInteractionAnswer`, and `writeNodeCheckpoint`, all accepting task-relative data only.
- Produces the interaction IDs and state transitions used by Tasks 3–6.

- [ ] **Step 1: Write failing migration and service tests**

Create tests that migrate an empty test database and assert:

```ts
await service.requestPlanInteraction({ taskId, planId, taskNodeId, request });
expect(await service.pendingForTask(taskId)).toEqual([
  expect.objectContaining({ state: 'pending', source: 'control_plane' }),
]);

await expect(service.respond({ taskId, interactionId, response: { decision: 'confirm' }, idempotencyKey: 'reply-1' }))
  .resolves.toMatchObject({ accepted: true, resumeRequired: true });
```

Cover database constraints for exactly one pending interaction per node/resume round, append-only message sequencing, and rejected traversal/absolute checkpoint paths. Also cover a response attachment flow that consumes a staged upload into a task-local immutable input and records `interaction_answer_attachment` audit metadata.

- [ ] **Step 2: Run the new persistence test to verify it fails**

Run: `pnpm vitest run tests/control-plane/database-migration.spec.ts tests/control-plane/task-interaction.service.spec.ts`

Expected: FAIL because migration 0006 and `TaskInteractionService` do not exist.

- [ ] **Step 3: Implement migration 0006 and contained workspace writers**

Create `task_interactions` with `task_id`, `task_plan_id`, nullable `task_node_id`, `plan_node_key`, `source` (`control_plane` or `agent`), `kind`, `title`, `prompt`, `response_schema`, `response_target`, `state`, `checkpoint`, nullable `requested_by_attempt_id`, answer/actor/timing fields, `resume_round`, and `idempotency_key`. Add a partial unique index for one pending interaction per `task_node_id` / `resume_round`.

Create `task_interaction_messages` with `(interaction_id, sequence)` uniqueness and roles `control_plane | agent | user | system`. Add `task_nodes.node_type text NOT NULL DEFAULT 'agent_call'`, `task_nodes.definition jsonb NOT NULL DEFAULT '{}'::jsonb`, and allow the documented states `awaiting_user_input`; add `yielded` as a supported `task_attempts.state`. Do not delete or repurpose historical `approval_requests` rows.

Extend the workspace service to create `interactions/<interaction-id>/`, write `request.json`, append `messages.jsonl`, persist `answer.json`, and validate every generated path under the task root. Extend `TaskInputService` with a dedicated `freezeForInteractionAnswer(taskId, interactionId, uploadIds, ownerSubject)` that reuses size/hash/ownership checks and places copies under `interactions/<id>/attachments/`, then creates normal task-input rows plus input-audit rows.

- [ ] **Step 4: Implement `TaskInteractionService` transaction boundaries**

Use one service as the only writer of interaction state. It must validate a stored bounded response schema through TypeBox before transitioning `pending → answered`; append the user message and answer snapshot; write a short redacted task-session/activity summary; and use the idempotency key to return the original accepted response without repeating file freezing or resume scheduling. It must expose a transaction-safe claim operation that Task 3/4 can use to mark `answered → resumed` only once.

- [ ] **Step 5: Run migration, service and type checks**

Run: `pnpm vitest run tests/control-plane/database-migration.spec.ts tests/control-plane/task-interaction.service.spec.ts && pnpm typecheck`

Expected: PASS; all task-local files stay contained and schema-invalid responses leave records pending.

- [ ] **Step 6: Commit durable interaction storage**

```bash
git add apps/control-plane/src/database apps/control-plane/src/tasks apps/control-plane/src/app.module.ts tests/control-plane
git commit -m "feat(control-plane): persist task interaction requests and answers"
```

## Task 3: Pause and Resume Compiled Human-Interaction Nodes

**Files:**
- Modify: `apps/control-plane/src/tasks/task-scheduler.service.ts`
- Modify: `apps/control-plane/src/tasks/task-session.service.ts`
- Modify: `apps/control-plane/src/tasks/tasks.service.ts`
- Modify: `tests/control-plane/task-scheduler.spec.ts`
- Modify: `tests/control-plane/tasks.e2e-spec.ts`

**Interfaces:**
- Consumes `TaskInteractionService.requestPlanInteraction`, `claimResume`, and `resumeContextForNode` from Task 2.
- Consumes normalized `CompiledHumanInteractionNode` from Task 1.
- Produces `TaskSchedulerService.advance(taskId)` behavior that pauses a ready human node, and `TaskSchedulerService.resumeInteraction(taskId, interactionId)` that only dispatches the unblocked branch.
- Task 4 reuses its resume-envelope path for agent-originated pauses.

- [ ] **Step 1: Extend scheduler tests with a plan-native confirmation gate**

Add a compiled test plan:

```ts
retrieve → confirm-audience (human_interaction) → create-presentation → finish
```

Assert that completing `retrieve` creates one pending interaction, sets `confirm-audience` and the task to `awaiting_user_input`, starts no presentation instance, and writes a `human_interaction_requested` activity. After a valid answer, assert the interaction is `resumed`, the interaction node is completed, exactly one presentation instance is launched, and the original retrieval attempt is not relaunched. Add the same assertion using a legacy `approval` plan fixture.

- [ ] **Step 2: Run the scheduler tests to verify the pause assertions fail**

Run: `pnpm vitest run tests/control-plane/task-scheduler.spec.ts tests/control-plane/tasks.e2e-spec.ts`

Expected: FAIL because only `agent_call` nodes are materialized and no interaction can be answered.

- [ ] **Step 3: Materialize the graph and dispatch by node type**

Refactor `ensurePlanNodes` to create a `task_nodes` runtime row for every compiled nonterminal node, storing `node_type`, immutable `definition`, dependencies, display title and rationale. For `agent_call`, retain existing workspace, capability and reviewed version logic. For `human_interaction`, create a runtime row without inventing an agent identity.

In `advance`, evaluate ready runtime rows by type: launch `agent_call`; call `TaskInteractionService.requestPlanInteraction` for `human_interaction`; retain the existing end/quality logic only after all required runtime nodes complete. The first interaction request must atomically mark the node/task as `awaiting_user_input`, update `state.json`, append session/activity records, and return without launching dependent nodes. Preserve independent branches only when their dependencies are already complete and they do not depend on the waiting node.

- [ ] **Step 4: Implement targeted static-node resumption**

Add `resumeInteraction(taskId, interactionId)` to claim an answered plan interaction, complete only its waiting runtime node, set task state to `planned`, append `human_interaction_resumed`, and call `advance(taskId)`. It must reject agent-originated interactions (Task 4 owns those) and be safe if a duplicate caller loses the claim. Ensure `TaskService` calls only this public scheduler API after a successful response.

- [ ] **Step 5: Run scheduler regression tests**

Run: `pnpm vitest run tests/control-plane/task-scheduler.spec.ts tests/control-plane/tasks.e2e-spec.ts tests/control-plane/task-review.e2e-spec.ts`

Expected: PASS; static interactions pause/unblock correctly and quality rework behavior remains unchanged.

- [ ] **Step 6: Commit plan-native pause/resume**

```bash
git add apps/control-plane/src/tasks tests/control-plane/task-scheduler.spec.ts tests/control-plane/tasks.e2e-spec.ts
git commit -m "feat(scheduler): pause and resume human interaction nodes"
```

## Task 4: Let an Agent Yield Safely and Resume from a Checkpoint

**Files:**
- Modify: `apps/control-plane/src/internal/instance-results.service.ts`
- Modify: `apps/control-plane/src/tasks/task-scheduler.service.ts`
- Modify: `apps/control-plane/src/tasks/task-workspace.service.ts`
- Modify: `tests/control-plane/instance-results.e2e-spec.ts`
- Modify: `tests/agents/agent-runtime.spec.ts`

**Interfaces:**
- Consumes the `needs_user_input` result and `TaskEnvelope.resume` types from Task 1.
- Consumes interaction/checkpoint persistence from Task 2.
- Produces an attempt state `yielded` and an agent-source interaction; after Task 5 answers it, `TaskSchedulerService.resumeInteraction` dispatches a new attempt with `envelope.resume`.

- [ ] **Step 1: Write failing result-callback tests for a yielded execution**

Extend the internal result test with a leased agent that reports:

```ts
{ status: 'needs_user_input', interaction: request, checkpoint: checkpointRef }
```

Assert the callback returns 201, marks the attempt `yielded`, marks its node/task `awaiting_user_input`, creates an `agent`-source interaction, and archives no ordinary artifacts. Assert an invalid SHA, missing checkpoint, traversal checkpoint, or a second normal result from the yielded instance is rejected. Then answer/resume it and assert the new envelope has `attemptNumber: 2` plus the validated checkpoint and answer, not any lease from attempt 1.

- [ ] **Step 2: Run the callback test to verify it fails**

Run: `pnpm vitest run tests/control-plane/instance-results.e2e-spec.ts tests/agents/agent-runtime.spec.ts`

Expected: FAIL because `AgentResultSchema` / result handling only permits succeeded or failed.

- [ ] **Step 3: Split yielded results from terminal artifact handling**

In `InstanceResultsService.accept`, branch on `result.status` after active-lease/task identity validation. For `needs_user_input`, verify the checkpoint is a regular file below the node workspace and matches its SHA-256; write it with `TaskWorkspaceService.writeNodeCheckpoint`; create the agent interaction; and in one transaction transition `task_attempts.leased → yielded`, `task_nodes → awaiting_user_input`, and `tasks → awaiting_user_input`.

Do not run artifact archiving for the yielding branch. Persist the raw validated yielded result for audit, append a secret-safe session entry and an activity with question title/source/node ID only, then let the reporting agent process exit normally after its callback; do not retain its lease or issue a hidden background continuation. Keep success/failure artifact behavior byte-for-byte compatible.

- [ ] **Step 4: Add agent-node resumption to the scheduler**

Extend `TaskSchedulerService.resumeInteraction` to identify an agent-originated answered interaction, claim it once, reset only the owning node to `pending`, preserve the checkpoint reference and answer history, transition the task to `planned`, and call `advance`. In `launch`, build `TaskEnvelope.resume` only from server-stored checkpoint/message rows for that node; never accept browser paths, instance IDs or lease tokens. The new attempt number must be obtained from the same attempt-number query used by ordinary retry dispatch.

- [ ] **Step 5: Run result and scheduler regression tests**

Run: `pnpm vitest run tests/control-plane/instance-results.e2e-spec.ts tests/control-plane/task-scheduler.spec.ts tests/agents/agent-runtime.spec.ts && pnpm typecheck`

Expected: PASS; late old-instance results cannot mutate the resumed node, while existing result/artefact cases still pass.

- [ ] **Step 6: Commit yielded-agent support**

```bash
git add apps/control-plane/src/internal apps/control-plane/src/tasks tests/control-plane/instance-results.e2e-spec.ts tests/agents/agent-runtime.spec.ts
git commit -m "feat(runtime): let agents yield for user input"
```

## Task 5: Expose Authenticated Answer, Cancel and Detail APIs

**Files:**
- Modify: `apps/control-plane/src/tasks/tasks.service.ts`
- Modify: `apps/control-plane/src/tasks/tasks.controller.ts`
- Modify: `apps/control-plane/src/tasks/task-inputs.controller.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Create: `tests/control-plane/task-interactions.e2e-spec.ts`
- Modify: `tests/control-plane/task-review.e2e-spec.ts`

**Interfaces:**
- Consumes `TaskInteractionService.respond`, `cancel`, `listForTask` and scheduler `resumeInteraction` from Tasks 2–4.
- Produces `GET /v1/tasks/:taskId/interactions`, `GET /v1/tasks/:taskId/interactions/:interactionId`, `POST /v1/tasks/:taskId/interactions/:interactionId/respond`, and `POST /v1/tasks/:taskId/interactions/:interactionId/cancel`.
- Extends the existing task detail payload with an `interactions` array; Task 6 renders it.

- [ ] **Step 1: Write authenticated endpoint tests before controller changes**

Test these request/response contracts:

```ts
POST /v1/tasks/task-1/interactions/int-1/respond
Headers: Authorization: Bearer <admin>, Idempotency-Key: answer-1
Body: { response: { decision: 'confirm' }, message: '按正式商务风格制作', inputIds: ['<staged-upload-id>'] }
```

Assert 201 includes the interaction ID and `state: 'resuming'`; a same-key retry returns the same logical result without a second attempt; a different concurrent response gets 409; unauthorized requests get 401/403; schema-invalid responses and upload IDs not owned/ready get 400; and a cancelled/expired/nonpending interaction gets 409. Assert `GET /v1/tasks/:id` exposes safe metadata/messages but not upload staging paths, lease tokens or answer attachments outside the task.

- [ ] **Step 2: Run interaction API tests to verify they fail**

Run: `pnpm vitest run tests/control-plane/task-interactions.e2e-spec.ts tests/control-plane/task-review.e2e-spec.ts`

Expected: FAIL because interaction routes and response DTOs do not exist.

- [ ] **Step 3: Implement API validation and response orchestration**

Add strict DTO checks: `response` must be a JSON object, `message` max 4,000 characters, `inputIds` must be distinct UUID strings, and `Idempotency-Key` must be a bounded printable header. Delegate schema checks/attachments to `TaskInteractionService`; do not put response interpretation in the controller.

After an accepted answer, `TaskService.respondToInteraction` must enqueue the exact `resumeInteraction` call, return a small safe result, write `human_interaction_answered`, and let the scheduler issue `human_interaction_resumed`. Add cancellation as an explicit administrator action that transitions the interaction/task to `cancelled` without launching downstream nodes. Preserve the existing `/review` contract and its quality-specific behavior.

- [ ] **Step 4: Run API and full control-plane behavior checks**

Run: `pnpm vitest run tests/control-plane/task-interactions.e2e-spec.ts tests/control-plane/task-review.e2e-spec.ts tests/control-plane/tasks.e2e-spec.ts tests/control-plane/task-artifacts.e2e-spec.ts`

Expected: PASS; reply attachments become task-owned snapshots and no legacy review route changes.

- [ ] **Step 5: Commit interaction APIs**

```bash
git add apps/control-plane/src/tasks apps/control-plane/src/app.module.ts tests/control-plane/task-interactions.e2e-spec.ts tests/control-plane/task-review.e2e-spec.ts
git commit -m "feat(api): add task interaction answer and cancel endpoints"
```

## Task 6: Preserve Waiting Tasks Through Restart and Explain Them to Operators

**Files:**
- Modify: `apps/control-plane/src/tasks/task-recovery.service.ts`
- Modify: `apps/control-plane/src/tasks/task-monitor.ts`
- Modify: `apps/control-plane/src/tasks/tasks.service.ts`
- Modify: `tests/control-plane/task-recovery.spec.ts`
- Modify: `tests/control-plane/task-monitor.spec.ts`
- Modify: `tests/control-plane/task-activity.spec.ts`

**Interfaces:**
- Consumes durable interaction state from Task 2 and scheduler resume behavior from Tasks 3–4.
- Produces workflow state `awaiting_user_input`, readable waiting duration/details, and restart behavior that deliberately does nothing until a response is accepted.

- [ ] **Step 1: Add failing recovery and projection tests**

Seed a task with one `awaiting_user_input` node, a `yielded` attempt and a pending interaction. Assert:

```ts
await recovery.recoverInterrupted();
expect(launcher.startInstance).not.toHaveBeenCalled();
expect(task.state).toBe('awaiting_user_input');
expect(workflow.find((stage) => stage.key === 'agent_execution')).toMatchObject({
  state: 'awaiting_user_input',
});
```

Also assert a normal expired `leased` attempt retains existing retry behavior, and interaction activities carry only IDs/title/source rather than full response text.

- [ ] **Step 2: Run recovery/monitor tests to verify the waiting-state cases fail**

Run: `pnpm vitest run tests/control-plane/task-recovery.spec.ts tests/control-plane/task-monitor.spec.ts tests/control-plane/task-activity.spec.ts`

Expected: FAIL because monitor types and recovery task queries do not know `awaiting_user_input`.

- [ ] **Step 3: Implement waiting-state recovery and readable monitor projection**

Keep `awaiting_user_input` outside both recovery rescheduling query sets. Do not classify `yielded` attempts as expired leases. Extend `MonitorStageState`, stage calculations and task detail query to include interaction count/current pending question metadata. The intent/orchestration/execution stage must say whether the middle platform or a named agent is waiting, the current question title, and elapsed time; the final acceptance stage must remain pending rather than falsely showing final review.

Ensure activity service redaction never serializes full `response`, `message`, raw checkpoint contents, tokens or arbitrary attachment paths into SSE detail.

- [ ] **Step 4: Run observability/recovery regressions**

Run: `pnpm vitest run tests/control-plane/task-recovery.spec.ts tests/control-plane/task-monitor.spec.ts tests/control-plane/task-activity.spec.ts tests/control-plane/task-liveness.spec.ts`

Expected: PASS; restart never resumes a waiting task and liveness handling remains limited to active leases.

- [ ] **Step 5: Commit durable waiting observability**

```bash
git add apps/control-plane/src/tasks apps/control-plane/src/observability tests/control-plane/task-recovery.spec.ts tests/control-plane/task-monitor.spec.ts tests/control-plane/task-activity.spec.ts
git commit -m "feat(observability): show and preserve tasks awaiting user input"
```

## Task 7: Add the Real-Time Console Interaction Surface

**Files:**
- Modify: `apps/console/src/lib/task-presenter.ts`
- Modify: `apps/console/src/App.tsx`
- Create: `apps/console/src/task-interactions.css`
- Modify: `apps/console/src/task-activity.css`
- Modify: `tests/console/task-presenter.spec.ts`
- Modify: `tests/console/workflow.spec.ts`

**Interfaces:**
- Consumes `detail.interactions`, workflow `awaiting_user_input`, and existing activity SSE updates from Task 5/6.
- Produces `TaskPresentation.interactions` and a task-detail “等待你的输入” card with a bounded form and optional staged-file selection/upload.

- [ ] **Step 1: Write failing presenter and workflow tests**

Add one detail fixture with a pending clarification and one with an answered/resumed interaction. Assert `presentTask` produces Chinese source/state labels, current wait duration inputs and no raw `response_schema` or private response in normal console entries. In DOM/workflow tests assert the user sees question title/prompt, a confirmation control or form field, submit disabled while posting, a readable validation error, and an SSE-driven transition from “等待你的输入” to “正在恢复智能体”.

- [ ] **Step 2: Run console tests to verify the new cases fail**

Run: `pnpm vitest run tests/console/task-presenter.spec.ts tests/console/workflow.spec.ts`

Expected: FAIL because `TaskPresentation` has no interaction model or answer controls.

- [ ] **Step 3: Implement a safe presentation model and controls**

Map only safe interaction metadata into `TaskPresentation`: ID, source, node key/title, kind, prompt, form fields, state, requested time, and existing task-input summaries. Render confirmation, clarification and limited form controls from the server-provided bounded schema; do not evaluate expressions or render HTML supplied by an agent. Reuse current staged upload route, then include returned upload IDs only in the answer request.

Use existing task SSE activity stream to refresh detail and show request/answer/resume events in the timeline/console. Keep raw schema/checkpoint/result bodies inside the existing developer-debug panel only, and continue omitting secrets/leases.

- [ ] **Step 4: Run console unit tests and production build**

Run: `pnpm vitest run tests/console/task-presenter.spec.ts tests/console/workflow.spec.ts && pnpm console:build`

Expected: PASS; the built console has no TypeScript/Vite errors.

- [ ] **Step 5: Commit the console interaction surface**

```bash
git add apps/console tests/console
git commit -m "feat(console): answer paused task interactions"
```

## Task 8: Document, Verify End-to-End, Deploy and Smoke-Test

**Files:**
- Modify: `apps/control-plane/src/tasks/README.md`
- Modify: `apps/control-plane/src/database/README.md`
- Modify: `docs/runbooks/control-console.md`
- Modify: `docs/runbooks/agent-orchestration.md`
- Modify: `docs/superpowers/specs/2026-11-12-human-interaction-and-task-resume-design.md`
- Modify: `docs/superpowers/plans/2026-11-12-human-interaction-and-task-resume.md`
- Create: `docs/runbooks/task-human-interaction.md`

**Interfaces:**
- Consumes the delivered protocol/API/state/UI behavior from Tasks 1–7.
- Produces operational instructions for responding, cancelling, diagnosing stalled tasks, restart semantics and preparing an agent-creator agent to yield safely.

- [ ] **Step 1: Add a real end-to-end test scenario**

Extend or add a control-plane E2E test that seeds a reviewed minimal agent. Its first attempt reports `needs_user_input` with a real task-local checkpoint, receives a response with one task-private attachment, and its second attempt returns a verified artifact. Assert task directory files, database audit/session/activity sequence, attempt numbers and final accepted task state.

- [ ] **Step 2: Run the E2E test to verify the complete path passes**

Run: `pnpm vitest run tests/control-plane/task-interactions.e2e-spec.ts tests/control-plane/instance-results.e2e-spec.ts`

Expected: PASS; one answer creates exactly one resumed attempt and final delivery remains downloadable.

- [ ] **Step 3: Update maintainer and operator documentation**

Document the state machine, endpoint examples without credentials, response schema limitations, task directory layout, activity/SSE event meanings, restart/non-auto-resume guarantee, private attachment lifetime, and late-callback diagnostics. Update the design decision record only if implementation reveals a justified deviation; otherwise mark it implemented and link this plan.

- [ ] **Step 4: Run complete verification before deployment**

Run: `pnpm test && pnpm typecheck && pnpm console:build && pnpm protocol:export && pnpm agent:validate`

Expected: PASS; no generated-schema diff remains and all existing agents validate.

- [ ] **Step 5: Deploy to 219 and run an operator smoke test**

Deploy the tested worktree to `/home/middleground/.worktrees/control-plane-ragflow-v1`, apply migration 0006 through the existing service deployment path, restart only the control-plane/console units, and verify their health logs. Submit the minimal yielding-agent task through the authenticated API, answer it from the console, verify SSE shows pause/answer/resume, then download its final artifact. Do not modify RAGFlow or the 栖知 repository.

- [ ] **Step 6: Commit documentation and deployment evidence**

```bash
git add apps/control-plane/src/tasks/README.md apps/control-plane/src/database/README.md docs tests/control-plane
git commit -m "docs: document resumable human task interactions"
```

## Self-Review

### Spec coverage

- Plan-native confirmation/clarification/form nodes: Tasks 1 and 3.
- Adaptive agent-originated questions with checkpoint/restart: Task 4.
- Durable database, task directory, private reply files, audit and idempotency: Task 2 and Task 5.
- SSE/console real-time operator experience: Tasks 6 and 7.
- No auto-resume across restart, plus safe old-attempt rejection: Tasks 4 and 6.
- Existing quality review/rework remains separate: Tasks 3 and 5 regression tests.
- Agent-creator preparation without creating it: Task 8 documentation and the Task 4 runtime contract.

No spec requirement is unassigned.

### Step and type consistency

`human_interaction`, `needs_user_input`, `awaiting_user_input`, `yielded`, `TaskInteractionService`, `resumeInteraction`, `TaskEnvelope.resume`, `task_interactions`, and `task_interaction_messages` use the same names in every task. All code steps declare the producing method or persistence record before a later task consumes it.

### Review-focus coverage

- Duplicate answers: Task 5, Step 1.
- Late yielded-instance output: Task 4, Step 1.
- Traversal/unowned/schema-invalid input: Task 2, Step 1; Task 5, Step 1.
- Restart while paused: Task 6, Step 1.
- Legacy approval compatibility: Task 1, Step 1; Task 3, Step 1.

### Proportion

The plan isolates the protocol boundary, persistence, graph scheduler, runtime callback, HTTP API, recovery/monitoring, console, and deployment. Each task has a standalone failing-test/pass-test cycle and a reviewable deliverable; it does not prescribe implementation bodies beyond security/state decisions fixed by the design.
