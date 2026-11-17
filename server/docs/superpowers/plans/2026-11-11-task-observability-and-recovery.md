# Task Observability and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task orchestration asynchronous, recoverable and observable in real time, while reliably registering every deployable agent package.

**Architecture:** Add an append-only activity stream shared by the control plane, scheduler and agent callbacks. An in-process publisher fans persisted activities to authenticated SSE clients; the database remains the reconnect source of truth. A task orchestrator detaches planning from the request path and resumes unfinished planning after restart. Package discovery reports each package outcome instead of stopping at the first error.

**Tech Stack:** NestJS/Fastify, PostgreSQL/TypeORM migrations, TypeScript, React/Vite, Server-Sent Events, Vitest, systemd journald.

**Spec:** `docs/superpowers/specs/2026-11-11-task-observability-and-recovery-design.md`

## Global Constraints

- Discovery must only read manifests and schemas; approval remains the trigger for first self-check.
- Do not include credentials, full prompts, model reasoning or unredacted runtime environment in activity events or logs.
- SSE is authenticated with a short-lived, task-scoped one-time ticket rather than an administrator token in a URL.
- Task workspaces stay inside `/home/middleground/data/workspaces` and retain task state/session artifacts.
- The initial publisher is process-local; the persisted event API must remain suitable for a later multi-server broker.

## Review Focus

- Reconnecting after events were missed returns every activity with an ID greater than `Last-Event-ID` exactly once in order.
- A planning error before `PlanningService` starts cannot leave a task permanently `planning`.
- A slow Codex command never blocks the task-creation HTTP response.
- A malformed package declaration records a failure but does not prevent the other four packages being registered.
- Event payload and operational logs redact tokens, keys and unbounded user/agent output.

---

### Task 1: Persist and publish task activity

**Files:**
- Create: `apps/control-plane/src/observability/task-activity.service.ts`
- Create: `apps/control-plane/src/observability/task-activity.types.ts`
- Create: `apps/control-plane/src/observability/README.md`
- Modify: `apps/control-plane/src/database/migrations/0003-task-observability.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Test: `tests/control-plane/task-activity.spec.ts`

**Interfaces:**
- Produces `TaskActivityService.append(input): Promise<TaskActivity>` and `TaskActivityService.listAfter(taskId, afterId): Promise<TaskActivity[]>`.
- Produces `TaskActivityPublisher.subscribe(taskId, listener): () => void` for SSE delivery.

- [ ] **Step 1: Write failing activity persistence and ordered-publisher tests**
- [ ] **Step 2: Run `./node_modules/.bin/vitest run tests/control-plane/task-activity.spec.ts` and observe missing-service failure**
- [ ] **Step 3: Add migration, typed activity service, redaction and process-local publisher**
- [ ] **Step 4: Re-run the focused activity tests**
- [ ] **Step 5: Commit `feat: persist task activity events`**

### Task 2: Make planning asynchronous and restart-safe

**Files:**
- Create: `apps/control-plane/src/tasks/task-orchestration.service.ts`
- Modify: `apps/control-plane/src/tasks/tasks.service.ts`
- Modify: `apps/control-plane/src/tasks/task-recovery.service.ts`
- Modify: `apps/control-plane/src/planning/planning.service.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Test: `tests/control-plane/task-orchestration.spec.ts`

**Interfaces:**
- Consumes `TaskActivityService.append` from Task 1.
- Produces `TaskOrchestrationService.enqueue(taskId): void`, `run(taskId): Promise<void>` and `recoverPlanning(): Promise<number>`.

- [ ] **Step 1: Write failing tests for immediate task creation, explicit planning failure and restart recovery**
- [ ] **Step 2: Run the focused orchestration tests and observe the synchronous/waiting behavior fail**
- [ ] **Step 3: Implement keyed orchestration, durable phase events and error-to-terminal-state handling**
- [ ] **Step 4: Re-run focused tests and then `./node_modules/.bin/vitest run`**
- [ ] **Step 5: Commit `feat: run planning asynchronously with recovery`**

### Task 3: Add authenticated SSE task stream

**Files:**
- Create: `apps/control-plane/src/observability/task-events.controller.ts`
- Create: `apps/control-plane/src/observability/stream-ticket.service.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Test: `tests/control-plane/task-events.e2e-spec.ts`

**Interfaces:**
- Consumes activity persistence/publisher from Task 1 and existing `AdminAuthGuard`.
- Produces authenticated ticket issuance and `GET /v1/tasks/:taskId/events/stream` with `snapshot`/`activity` SSE events.

- [ ] **Step 1: Write failing HTTP tests for authorization, ticket scope/expiry, snapshot and Last-Event-ID replay**
- [ ] **Step 2: Run focused SSE tests and observe the routes are absent**
- [ ] **Step 3: Implement one-time stream tickets and Fastify SSE response lifecycle**
- [ ] **Step 4: Re-run focused SSE tests**
- [ ] **Step 5: Commit `feat: stream task activity over sse`**

### Task 4: Make package discovery resilient and auditable

**Files:**
- Modify: `apps/control-plane/src/registry/agent-package-discovery.service.ts`
- Modify: `apps/control-plane/src/main.ts`
- Modify: `apps/control-plane/src/registry/README.md`
- Test: `tests/control-plane/agent-package-discovery.spec.ts`

**Interfaces:**
- Produces `DiscoveryResult[]` containing package path, agent identity when known, status and bounded failure reason.

- [ ] **Step 1: Write a failing test with one malformed directory followed by valid packages**
- [ ] **Step 2: Run the discovery test and observe scanning stops at the malformed package**
- [ ] **Step 3: Continue per-package discovery, record audit outcome and emit structured startup summary**
- [ ] **Step 4: Re-run the focused test**
- [ ] **Step 5: Commit `fix: keep agent discovery running after package errors`**

### Task 5: Add structured operational logging at runtime boundaries

**Files:**
- Create: `apps/control-plane/src/observability/operational-logger.ts`
- Modify: `apps/control-plane/src/tasks/task-scheduler.service.ts`
- Modify: `apps/control-plane/src/internal/instance-events.service.ts`
- Modify: `apps/control-plane/src/internal/instance-results.service.ts`
- Modify: `apps/control-plane/src/registry/registry.service.ts`
- Modify: `apps/node-manager/src/**/*.ts`
- Create: `docs/runbooks/task-observability.md`
- Test: `tests/control-plane/operational-logger.spec.ts`

**Interfaces:**
- Produces `OperationalLogger.info|warn|error(context, message, detail)` with JSON-safe, redacted records.

- [ ] **Step 1: Write failing redaction and correlation-ID tests**
- [ ] **Step 2: Run focused logger tests and observe the logger is absent**
- [ ] **Step 3: Implement the logger and add boundary records for discovery, planning, scheduling, callback and result transitions**
- [ ] **Step 4: Document journald and database-event troubleshooting commands without printing secrets**
- [ ] **Step 5: Run focused tests and commit `feat: add structured operational logs`**

### Task 6: Replace polling monitor with an SSE activity timeline

**Files:**
- Create: `apps/console/src/lib/task-event-stream.ts`
- Modify: `apps/console/src/App.tsx`
- Modify: `apps/console/src/lib/task-presenter.ts`
- Modify: `apps/console/src/styles.css`
- Modify: `apps/console/README.md`
- Test: `tests/console/task-event-stream.spec.ts`
- Test: `tests/console/task-presenter.spec.ts`

**Interfaces:**
- Consumes task detail snapshot and the ticket/SSE API from Task 3.
- Produces a connection indicator, ordered Chinese activity timeline and reconnect/fallback status.

- [ ] **Step 1: Write failing tests for ticketed stream lifecycle, ordered activity projection and reconnection state**
- [ ] **Step 2: Run console tests and observe missing stream support**
- [ ] **Step 3: Implement EventSource lifecycle, initial snapshot, activity updates and readable monitoring cards**
- [ ] **Step 4: Re-run console tests and production console build**
- [ ] **Step 5: Commit `feat: show live task activity in console`**

### Task 7: Deploy, recover and validate real lifecycle

**Files:**
- Modify: module READMEs and `docs/runbooks/task-observability.md` if deployment evidence changes instructions.

- [ ] **Step 1: Run the complete test suite, typecheck and production build**
- [ ] **Step 2: Deploy to 219, run migrations and restart only the control-plane/node-manager services**
- [ ] **Step 3: Verify all five agent packages are listed as pending review without self-checking them**
- [ ] **Step 4: Verify the stuck task records a terminal/recovery activity instead of remaining opaque**
- [ ] **Step 5: In the rendered console, verify live SSE connection and at least one visible activity transition**
- [ ] **Step 6: Commit deployment-ready documentation changes**
