# Real Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard-coded single knowledge retrieval with a Codex-planned, validated, independently executed, recoverable multi-agent task runtime that can produce and quality-check a 438c project-introduction PPT.

**Architecture:** The control plane persists each task and creates a durable task directory. A Codex planner produces a constrained graph from the current ready-capability catalog; the compiler validates it, and a scheduler launches reviewed agent packages as transient systemd instances through the node manager. Agents receive a versioned envelope, emit human-readable lifecycle events, and post a schema-checked final result; the control plane alone advances task state and renders an understandable execution trace.

**Tech Stack:** Node.js 22, TypeScript, NestJS/Fastify, TypeORM/PostgreSQL, TypeBox, systemd transient units, local Codex CLI, React/Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-real-agent-orchestration-design.md`

## Global Constraints

- Every task uses `/home/middleground/data/workspaces/<task-id>` and the documented layout; state/session files must never include secrets.
- Only an approved `ready` agent version with a synchronized, reviewed command may be launched.
- The control plane never imports an agent `runTask` implementation for production execution.
- Planner output is untrusted until schema, catalog, graph, path, dependency and input-binding checks pass.
- Use the already authenticated local `codex` CLI only via a bounded runtime adapter; persist user-readable summaries, not private chain-of-thought.
- Agent events and result callbacks require an active lease, are sequence/idempotency safe, and contain human-readable messages.
- A quality failure can request at most one automatic rework attempt; further failure awaits a human decision.
- Test-first every behavior; run the full suite, TypeScript check, console build, and 219 deployment verification before completion.

## Review Focus

- Node manager restart after capability approval must still reject unknown/obsolete packages and launch the recorded ready version only. (Task 3)
- Planner hallucination of a capability, cyclic graph, unsatisfied schema, or an input binding from a non-dependency must fail before any instance launches. (Task 4)
- Duplicate/late events or results, expired leases, and a node result outside the task directory must never advance the task. (Task 5)
- Control-plane restart must resume only unconfirmed work and must not duplicate an accepted node result or PPT artifact. (Task 5)
- A 438c query with insufficient enterprise evidence must surface the shortage and approval/research decision instead of fabricating facts in the PPT. (Tasks 6 and 8)

---

### Task 1: Extend the versioned agent protocol and durable orchestration model

**Files:**
- Modify: `packages/agent-protocol/src/schemas.ts`
- Modify: `packages/agent-protocol/src/types.ts`
- Modify: `packages/agent-protocol/src/compiler.ts`
- Create: `apps/control-plane/src/database/migrations/0002-agent-orchestration.ts`
- Modify: `apps/control-plane/src/database/README.md`
- Modify: `agents/*/agent.yaml`
- Test: `tests/contracts/agent-protocol.spec.ts`
- Test: `tests/control-plane/database-migration.spec.ts`

**Interfaces:**
- Produces `AgentManifest.entryCommand: string[]`, `TaskEnvelope.taskRoot`, `TaskEnvelope.nodeWorkspacePath`, `TaskEnvelope.resultCallback`, `TaskEnvelope.deadlineAt`, and an optional checkpoint reference.
- Produces `AgentResult` result-callback payload validation and a `TaskPlan` agent-node `inputBindings` list. A binding names a target input field, a dependency node, an approved result/evidence/artifact selector and a materialization format.
- Produces durable node metadata: capability, selected agent ID/version, dependencies, task/node workspace paths, rationale, display title, unit name, heartbeat and result timestamps.

- [ ] **Step 1: Write failing protocol and migration tests**

Add tests that accept a reviewed manifest with a command, compile a valid bound PPT node, and reject unknown capabilities, non-dependency bindings, absolute/traversing artifact paths and a result callback without the active lease. Add migration assertions for all scheduler fields and session records.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/contracts/agent-protocol.spec.ts tests/control-plane/database-migration.spec.ts`

Expected: FAIL because the new protocol fields, binding validation and migration do not exist.

- [ ] **Step 3: Implement protocol, compiler checks and migration**

Add exact TypeBox schemas and TypeScript types. Keep static input validation after deterministic binding placeholders are materialized; require each binding source to be listed in `dependsOn`. Add migration `0002-agent-orchestration.ts`, using additive columns/tables only: `task_sessions`, node dependency/agent/display/workspace fields, attempt unit/heartbeat/result fields, and task planner metadata. Add reviewed `entryCommand` arrays to all four manifests.

- [ ] **Step 4: Document the database and protocol changes**

Update database documentation with every new table/field, state ownership and the distinction between directory state and PostgreSQL state.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/contracts/agent-protocol.spec.ts tests/control-plane/database-migration.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-protocol apps/control-plane/src/database agents tests/contracts tests/control-plane/database-migration.spec.ts
git commit -m "feat: extend agent protocol for orchestration"
```

### Task 2: Build the task-directory, session and state-snapshot service

**Files:**
- Create: `apps/control-plane/src/tasks/task-workspace.service.ts`
- Create: `apps/control-plane/src/tasks/task-session.service.ts`
- Create: `apps/control-plane/src/tasks/README.md` additions
- Test: `tests/control-plane/task-workspace.spec.ts`
- Test: `tests/control-plane/task-session.spec.ts`

**Interfaces:**
- Produces `TaskWorkspaceService.create(task): Promise<TaskWorkspace>` with task root, plans, session, nodes, artifacts and quality paths.
- Produces `TaskWorkspaceService.createNodeWorkspace(taskId, nodeKey)` and `writeNodeEnvelope(...)` constrained to the task root.
- Produces `TaskSessionService.append(taskId, entry)` and `writeStateSnapshot(taskId, snapshot)`; session data is append-only JSONL and state uses atomic replace.

- [ ] **Step 1: Write failing workspace/session tests**

Cover exact directory creation, task metadata/state content, atomic state replacement, append-only session entries, permitted nested node/artifact paths and rejection of `..`, absolute or cross-task paths. Assert no environment-variable values are written.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/control-plane/task-workspace.spec.ts tests/control-plane/task-session.spec.ts`

Expected: FAIL because the services are missing.

- [ ] **Step 3: Implement task workspace and session services**

Use `resolve`/`relative` path containment checks, atomic temporary-file rename for `state.json`, and JSONL for `session/conversation.jsonl`. Write only task metadata, planner summaries, states and public execution facts; keep environment files outside session/plan/state files with mode `0600`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/control-plane/task-workspace.spec.ts tests/control-plane/task-session.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/tasks tests/control-plane/task-workspace.spec.ts tests/control-plane/task-session.spec.ts
git commit -m "feat: persist task workspaces and sessions"
```

### Task 3: Make node-manager catalog synchronization and independent instance launch real

**Files:**
- Modify: `apps/control-plane/src/registry/registry.service.ts`
- Modify: `apps/control-plane/src/registry/node-manager.http-client.ts`
- Modify: `apps/node-manager/src/catalog/package-catalog.service.ts`
- Modify: `apps/node-manager/src/control/control.service.ts`
- Modify: `apps/node-manager/src/control/control.controller.ts`
- Modify: `apps/node-manager/src/supervisor/systemd.supervisor.ts`
- Modify: `apps/node-manager/src/supervisor/supervisor.ts`
- Modify: `apps/node-manager/src/app.module.ts`
- Modify: `apps/node-manager/src/main.ts`
- Test: `tests/node-manager/package-catalog.spec.ts`
- Test: `tests/node-manager/control.spec.ts`
- Test: `tests/control-plane/registry.e2e-spec.ts`

**Interfaces:**
- Produces authenticated `POST /internal/v1/catalog/ready-versions` to upsert only reviewed launch records.
- Changes `startInstance` to accept a catalog key, task/node directories, envelope path and environment file; command/package path come only from the synchronized catalog.
- Produces `StartedInstance { instanceId, unitName }`, persisted by the scheduler.

- [ ] **Step 1: Write failing catalog and launch tests**

Test durable rehydration from a local catalog-state file, overwrite behavior for a new approved version, rejection of a caller-provided arbitrary command, and systemd argument construction with `EnvironmentFile=` plus the reviewed command.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/node-manager/package-catalog.spec.ts tests/node-manager/control.spec.ts tests/control-plane/registry.e2e-spec.ts`

Expected: FAIL because ready-version synchronization and safe launch metadata are absent.

- [ ] **Step 3: Implement catalog synchronization and secure launch**

Persist the node-manager catalog under `/home/middleground/data/node-manager/`; synchronize a ready record after self-check and hydrate it at boot. Use systemd transient units with task node working directory and `--property=EnvironmentFile=<0600 file>`. Preserve root-account operation but reject any command not recorded for the requested reviewed version.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/node-manager/package-catalog.spec.ts tests/node-manager/control.spec.ts tests/control-plane/registry.e2e-spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/registry apps/node-manager tests/node-manager tests/control-plane/registry.e2e-spec.ts
git commit -m "feat: synchronize ready agent launch catalog"
```

### Task 4: Add the Codex planner and plan compilation boundary

**Files:**
- Create: `apps/control-plane/src/planning/capability-catalog.service.ts`
- Create: `apps/control-plane/src/planning/codex-planner.service.ts`
- Create: `apps/control-plane/src/planning/planning.service.ts`
- Create: `apps/control-plane/src/planning/planner-output.schema.json`
- Create: `apps/control-plane/src/planning/README.md`
- Modify: `apps/control-plane/src/app.module.ts`
- Modify: `apps/control-plane/src/config/env.ts`
- Modify: `packages/codex-runtime/src/index.ts`
- Test: `tests/control-plane/codex-planner.spec.ts`
- Test: `tests/control-plane/planning.service.spec.ts`

**Interfaces:**
- Produces `CapabilityCatalogService.listReady(): ReadyCapability[]` from approved agent versions and their persisted JSON Schemas.
- Produces `CodexPlannerService.plan({ task, capabilities, workspace }): Promise<PlannerOutput>` with schema-constrained Codex output and a non-sensitive Chinese summary.
- Produces `PlanningService.createAndCompile(taskId): Promise<CompiledTaskPlan>`; it persists raw/compiled plan files, DB plan version and a session entry.

- [ ] **Step 1: Write failing planner tests**

Use an injected fake Codex runner to prove that a planner sees only ready capabilities, persists a Chinese summary and compiles a valid multi-retrieval → PPT → quality graph. Add failures for invented `document.write`, cyclic graph, invalid PPT input, non-dependency binding, and one repair attempt followed by a visible planning failure.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/control-plane/codex-planner.spec.ts tests/control-plane/planning.service.spec.ts`

Expected: FAIL because planning services and constrained planner output do not exist.

- [ ] **Step 3: Implement the planner services**

Extend `CodexCliRunner` with timeout, output schema, task-local stdout/stderr summary files and cancellation support. The planner prompt must request intent, deliverables, assumptions, risks, graph nodes and human-readable node reasons; it must never request or store model chain-of-thought. Compile each output with the real ready catalog; permit one structured repair prompt only for compiler errors.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/control-plane/codex-planner.spec.ts tests/control-plane/planning.service.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/planning apps/control-plane/src/app.module.ts apps/control-plane/src/config packages/codex-runtime tests/control-plane/codex-planner.spec.ts tests/control-plane/planning.service.spec.ts
git commit -m "feat: plan tasks with constrained codex output"
```

### Task 5: Implement the durable scheduler, callbacks, recovery and one rework policy

**Files:**
- Create: `apps/control-plane/src/tasks/task-scheduler.service.ts`
- Create: `apps/control-plane/src/tasks/task-recovery.service.ts`
- Modify: `apps/control-plane/src/tasks/tasks.service.ts`
- Modify: `apps/control-plane/src/tasks/tasks.controller.ts`
- Modify: `apps/control-plane/src/internal/instance-events.service.ts`
- Modify: `apps/control-plane/src/internal/instance-events.controller.ts`
- Create: `apps/control-plane/src/internal/instance-results.service.ts`
- Create: `apps/control-plane/src/internal/instance-results.controller.ts`
- Modify: `apps/control-plane/src/tasks/task-monitor.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Test: `tests/control-plane/task-scheduler.spec.ts`
- Test: `tests/control-plane/instance-results.e2e-spec.ts`
- Test: `tests/control-plane/task-recovery.spec.ts`

**Interfaces:**
- Produces `TaskSchedulerService.advance(taskId): Promise<void>` and `recoverInterrupted(): Promise<void>`.
- Produces authenticated `POST /internal/v1/instances/:instanceId/result` accepting the final Agent Protocol result.
- Produces readable `TaskDetail` containing plan summary, graph, node reason, current message/progress, results, quality conclusion and raw debug data.

- [ ] **Step 1: Write failing scheduler/callback/recovery tests**

Test topological launch order, multiple retrieval nodes becoming runnable in parallel, dependent PPT waiting for materialized evidence, only verified result callback advancing the node, event/result idempotency, heartbeats extending a lease, stopped/expired attempts becoming interrupted, resume with a new attempt, and one quality-directed retry only.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/control-plane/task-scheduler.spec.ts tests/control-plane/instance-results.e2e-spec.ts tests/control-plane/task-recovery.spec.ts`

Expected: FAIL because generic scheduling, result callbacks and recovery do not exist.

- [ ] **Step 3: Implement state transitions and scheduling**

Replace `createKnowledgeTask` with generic task creation followed by `planning`. Persist each compiled node, resolve only dependency-declared artifact/evidence bindings into task-local material files, then lease and launch through `HttpNodeManagerClient`. Store unit/attempt metadata before launch. Accept human-readable events, check result artifact containment and SHA-256 before advancing nodes, mirror events/results into task directories, and update state snapshots/session/audit records at every transition. Run recovery at control-plane startup and schedule the single permissible quality rework.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/control-plane/task-scheduler.spec.ts tests/control-plane/instance-results.e2e-spec.ts tests/control-plane/task-recovery.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/tasks apps/control-plane/src/internal apps/control-plane/src/app.module.ts tests/control-plane
git commit -m "feat: schedule and recover independent agent instances"
```

### Task 6: Adapt all agent packages to the independent-instance protocol

**Files:**
- Create: `packages/agent-runtime/src/bootstrap.ts`
- Create: `packages/agent-runtime/src/result-reporter.ts`
- Modify: `agents/ragflow-knowledge/src/main.ts`
- Modify: `agents/ragflow-knowledge/src/reporter.ts`
- Modify: `agents/web-research/src/main.ts`
- Modify: `agents/web-research/src/reporter.ts`
- Modify: `agents/ppt-maker/src/main.ts`
- Modify: `agents/ppt-maker/src/reporter.ts`
- Modify: `agents/ppt-maker/src/run-task.ts`
- Modify: `agents/quality-management/src/main.ts`
- Modify: `agents/quality-management/src/reporter.ts`
- Modify: `agents/quality-management/src/run-task.ts`
- Modify: `agents/*/README.md`
- Test: `tests/agents/agent-runtime.spec.ts`
- Test: `tests/agents/ragflow-knowledge.spec.ts`
- Test: `tests/agents/ppt-maker.spec.ts`
- Test: `tests/agents/quality-management.spec.ts`

**Interfaces:**
- Produces common `loadAgentExecution()` that reads only the reviewed systemd environment and task envelope, validates containment and exposes the event/result callbacks.
- Produces `postResult(result)` after each agent writes node-local `result.json`.
- PPT inputs can contain materialized, task-local evidence files; quality inputs can contain registered artifacts only.

- [ ] **Step 1: Write failing agent-runtime and capability tests**

Test environment-file bootstrapping, ordered human-readable events, final result posting, result-file containment, retrieval result evidence preservation, PPT use of materialized reference files and Codex result summary, and quality inspection of only registered PPT artifacts.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/agents/agent-runtime.spec.ts tests/agents/ragflow-knowledge.spec.ts tests/agents/ppt-maker.spec.ts tests/agents/quality-management.spec.ts`

Expected: FAIL because agents currently only write local result files and do not use the common instance protocol.

- [ ] **Step 3: Implement common bootstrap and update agents**

Load credentials from the systemd environment, not from task files. Make every agent write its result under its node workspace and post the validated result. Preserve native runtime for retrieval/research; ensure PPT and quality visibly report their Codex phases and include only a short final Codex summary. Update PPT prompt to read the materialized enterprise evidence, state provenance and flag insufficient evidence; do not invent project facts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/agents/agent-runtime.spec.ts tests/agents/ragflow-knowledge.spec.ts tests/agents/ppt-maker.spec.ts tests/agents/quality-management.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime agents tests/agents
git commit -m "feat: run agents through durable callbacks"
```

### Task 7: Replace JSON-first console monitoring with a readable execution console

**Files:**
- Modify: `apps/console/src/App.tsx`
- Modify: `apps/console/src/lib/workflow.ts`
- Modify: `apps/console/src/styles.css`
- Modify: `apps/console/README.md`
- Modify: `docs/runbooks/control-console.md`
- Test: `tests/console/workflow.spec.ts`
- Test: `tests/console/task-presenter.spec.ts`

**Interfaces:**
- Consumes the new `TaskDetail` presenter response, not raw relational rows as the primary view.
- Produces user-facing Chinese stage cards for intent, plan, each agent node, quality decision and delivery; JSON/event/lease/unit detail is collapsed under “开发调试”.

- [ ] **Step 1: Write failing presenter and UI rendering tests**

Cover a planned 438c task with three retrieval nodes, PPT and quality nodes; assert visible intent, capability reason, runtime, progress, duration, evidence/artefact names, quality decision and a debug-only JSON section. Test `interrupted`, `awaiting_approval` and `failed` messages.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/console/workflow.spec.ts tests/console/task-presenter.spec.ts`

Expected: FAIL because the presenter and readable state cards do not exist.

- [ ] **Step 3: Implement the console presenter and interaction flow**

Keep task input, approval and automatic refresh. Render the actual DAG, planned reason and current waiting cause in Chinese. Show artifacts and evidence summaries as links/cards; preserve raw event payloads, instance IDs, leases and JSON in a collapsed developer section only. Add a visible Codex-runtime badge to planning/PPT/quality nodes when reported by real data.

- [ ] **Step 4: Run tests and rendered browser validation**

Run: `./node_modules/.bin/vitest run tests/console/workflow.spec.ts tests/console/task-presenter.spec.ts && corepack pnpm run console:build`

Expected: PASS and production bundle created. Validate login, submit, live planned task view, expanded node card and mobile rendering through the available browser path.

- [ ] **Step 5: Commit**

```bash
git add apps/console docs/runbooks/control-console.md tests/console
git commit -m "feat: show readable multi-agent execution traces"
```

### Task 8: Deploy and verify the 438c project-introduction PPT workflow on 219

**Files:**
- Modify: `infra/systemd/*` only if the verified services need an environment or startup change
- Modify: `docs/runbooks/control-console.md`
- Modify: `docs/runbooks/agent-orchestration.md`
- Test: `tests/e2e/438c-presentation.spec.ts`

**Interfaces:**
- Consumes the deployed ready catalog and the user goal `制作一个关于438c项目介绍的PPT`.
- Produces a task directory, real plan/instance records, `presentation.pptx`, quality assessment and a final accepted/awaiting-approval outcome.

- [ ] **Step 1: Write an environment-safe end-to-end contract test**

Create a test with faked Codex/RAGFlow/node-manager boundaries that asserts the 438c plan contains multiple knowledge requests, a PPT node and a quality node. It must assert no fixed `knowledge.retrieve` plan is substituted.

- [ ] **Step 2: Run the end-to-end test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/e2e/438c-presentation.spec.ts`

Expected: FAIL until the orchestration path is wired end-to-end.

- [ ] **Step 3: Complete service wiring and run all automated verification**

Discover/approve/synchronize agent packages, apply migrations, build the console and restart services. Run the 438c task against the real RAGFlow dataset and local Codex CLI. Verify each independent systemd instance, task directory, event/result sequence, PPT artifact, quality decision and one recovery simulation. If enterprise evidence is insufficient, report that state rather than treating the PPT as factually accepted.

- [ ] **Step 4: Run full verification**

Run: `./node_modules/.bin/tsc --noEmit && corepack pnpm run console:build && ./node_modules/.bin/vitest run`

Expected: PASS. Then validate the 219 control console using the task URL and the real task trace.

- [ ] **Step 5: Commit**

```bash
git add infra/systemd docs/runbooks tests/e2e
git commit -m "feat: verify real 438c presentation orchestration"
```

## Self-review

- **Spec coverage:** Tasks 1–3 establish protocol, database, directory and independent launch; Task 4 establishes Codex planning; Task 5 establishes execution/recovery; Task 6 makes agents conform; Task 7 replaces JSON-first monitoring; Task 8 proves the required 438c workflow on 219.
- **Type consistency:** The planner returns `TaskPlan`; compiler returns `CompiledTaskPlan`; scheduler writes `TaskEnvelope`; agent returns `AgentResult`; only the result controller commits completion.
- **Review focus:** Each listed risk has a named test in Tasks 3–8.
- **Proportion:** The plan defines interfaces, paths and behavioral tests without embedding implementation bodies.
