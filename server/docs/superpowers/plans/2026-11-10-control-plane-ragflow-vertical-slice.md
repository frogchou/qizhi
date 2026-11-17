# Control Plane RAGFlow Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable enterprise-agent vertical slice: a natural-language task is planned by the control plane, dispatched to an approved RAGFlow knowledge-query agent, persisted, recovered, and returned for automatic or human acceptance.

**Architecture:** Keep the control plane and node manager as separate NestJS applications, with PostgreSQL as the durable source of truth. Define all inter-process data in a language-neutral TypeBox/JSON Schema protocol package; an on-demand agent worker reports signed events back to the control plane. The planner is a control-plane module backed by the local Codex app-server, while RAGFlow is accessed through a read-only adapter whose results become cited evidence.

**Tech Stack:** Node.js 22 LTS, TypeScript, pnpm workspace, NestJS with Fastify, TypeORM/PostgreSQL, Docker Compose, TypeBox/Ajv, Vitest, native `fetch`, systemd transient units, Codex app-server, RAGFlow HTTP API.

**Spec:** `/home/middleground/docs/superpowers/specs/2026-11-10-enterprise-agent-control-plane-design.md`

## Global Constraints

- Deploy and store all project artifacts under `/home/middleground` on 219; run the first release as `root` because that account owns the established Codex login.
- Keep the control plane, node manager, and agents separate processes. Only the node manager may create or stop agent process instances.
- Only one administrator exists in this release. Authenticate every external control-plane API call with a fixed bearer token verified against `MG_ADMIN_TOKEN_HASH`; never record the original token.
- Store RAGFlow endpoint in `RAGFLOW_BASE_URL` and its API key only in a root-owned, mode `0600` environment file outside Git. Never place it in source, tests, fixtures, prompts, logs, database rows, or command output.
- RAGFlow access is read-only. Treat an HTTP response as successful only when its JSON business `code` is `0`.
- Packages are discovered statically and stay `pending_review` until administrator approval. Do not execute package code before approval; execute its self-check only after approval.
- The planner may produce a graph only from registered `ready` capabilities. The compiler, not the planner, authorizes execution.
- Smart agents may use the permitted root account's shell, network and files, but the first vertical-slice agent performs only RAGFlow reads and writes its task directory.
- Preserve every task decision, instance state, event, result, acceptance decision, lease and checkpoint in PostgreSQL. Human rejection never starts an automatic retry.

## Review Focus

- RAGFlow returns HTTP 200 with `code != 0`: Task 4 verifies it becomes a typed retrieval failure, not empty evidence.
- A planner invents an unavailable capability or a malformed DAG: Task 8 verifies the compiler rejects it before any node is leased.
- A stale or duplicate worker callback arrives after a new attempt: Task 9 verifies the lease token and per-instance event sequence reject it without changing task state.
- A server restart occurs after an agent was leased but before it reports completion: Task 9 verifies recovery creates exactly one resumed attempt from the latest confirmed checkpoint.
- An unapproved package is discovered: Task 6 verifies no self-check or task launch occurs until an administrator explicitly approves its exact version.

---

## File Structure

```text
/home/middleground/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  infra/
    compose/postgres.compose.yaml
    env/control-plane.env.example
    systemd/mg-node-manager.service
    systemd/mg-control-plane.service
  packages/
    agent-protocol/src/{schemas.ts,types.ts,index.ts}
    ragflow-client/src/{client.ts,types.ts,index.ts}
  apps/
    control-plane/src/
      app.module.ts
      config/{env.ts,auth.guard.ts}
      database/{data-source.ts,entities/*,migrations/*}
      registry/{registry.module.ts,registry.service.ts,registry.controller.ts}
      tasks/{tasks.module.ts,tasks.service.ts,tasks.controller.ts,compiler.ts,recovery.service.ts}
      planner/{planner.module.ts,codex-app-server.runtime.ts,planner.service.ts}
      internal/{instance-events.controller.ts}
      acceptance/{acceptance.service.ts,acceptance.controller.ts}
    node-manager/src/
      app.module.ts
      control/{control.controller.ts,control.service.ts}
      supervisor/{supervisor.ts,systemd.supervisor.ts}
      catalog/{package-catalog.service.ts}
  agents/
    ragflow-knowledge/
      agent.yaml
      src/{main.ts,self-check.ts,run-task.ts,reporter.ts}
      schemas/{input.schema.json,result.schema.json}
  tests/
    contracts/*
    ragflow-client/*
    control-plane/*
    node-manager/*
    e2e/*
```

## Tasks

### Task 1: Create the TypeScript workspace and secure runtime configuration

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `infra/env/control-plane.env.example`, `apps/control-plane/src/config/env.ts`, `apps/control-plane/src/config/env.spec.ts`
- Modify: `docs/superpowers/specs/2026-11-10-enterprise-agent-control-plane-design.md` only if configuration names diverge

**Interfaces:**
- Produces: `loadControlPlaneEnv(source: NodeJS.ProcessEnv): ControlPlaneEnv`
- `ControlPlaneEnv` exposes `port`, `databaseUrl`, `adminTokenHash`, `nodeManagerUrl`, `ragflowBaseUrl`, `ragflowDatasetIds`, and never exposes the RAGFlow secret in a serializable object.

- [ ] **Step 1: Write failing environment-validation tests**

Cover a complete configuration, an absent `MG_ADMIN_TOKEN_HASH`, an invalid `RAGFLOW_BASE_URL`, and an example environment file that contains variable names but no real credentials.

- [ ] **Step 2: Run the environment tests to verify they fail**

Run: `pnpm vitest run apps/control-plane/src/config/env.spec.ts`

Expected: FAIL because the workspace and loader do not exist.

- [ ] **Step 3: Create the pnpm workspace and implement `loadControlPlaneEnv`**

Use Node.js 22, strict TypeScript, Vitest, and a root `.gitignore` that excludes every `.env` file except `*.env.example`, task artifacts, PostgreSQL data, generated coverage, and `node_modules`.

- [ ] **Step 4: Run tests and type checking**

Run: `pnpm install && pnpm vitest run apps/control-plane/src/config/env.spec.ts && pnpm typecheck`

Expected: PASS; `git status --ignored` must show no real environment file as trackable.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore infra/env apps/control-plane/src/config
git commit -m "chore: bootstrap typescript workspace"
```

### Task 2: Add PostgreSQL infrastructure and durable task-state entities

**Files:**
- Create: `infra/compose/postgres.compose.yaml`
- Create: `apps/control-plane/src/database/data-source.ts`
- Create: `apps/control-plane/src/database/entities/{agent,agent-version,task,task-plan,task-node,task-attempt,task-event,task-checkpoint,approval-request,audit-event}.entity.ts`
- Create: `apps/control-plane/src/database/migrations/0001-initial-control-plane.ts`
- Test: `tests/control-plane/database-migration.spec.ts`

**Interfaces:**
- Produces: `ControlPlaneDataSource` and `runMigrations(dataSource: DataSource): Promise<void>`.
- `TaskAttempt` owns `leaseToken`, `leaseExpiresAt`, `instanceId`, `attemptNumber`, and `state`; `TaskEvent` has a unique `(instanceId, sequence)` key.

- [ ] **Step 1: Write migration tests against a disposable PostgreSQL database**

Assert the initial migration creates all entity tables, unique agent `(agentId, version)` and event `(instanceId, sequence)` constraints, and an append-only audit table without an update/delete repository method.

- [ ] **Step 2: Run the migration test to verify it fails**

Run: `pnpm vitest run tests/control-plane/database-migration.spec.ts`

Expected: FAIL because the schema and Compose service do not exist.

- [ ] **Step 3: Implement the Compose service, TypeORM entities, and migration**

Bind PostgreSQL data to `/home/middleground/data/postgres` in deployment configuration. Keep database password variables external to Git. Store immutable payload snapshots as JSONB; store file artifacts as path/hash metadata rather than database blobs.

- [ ] **Step 4: Start the database and verify migrations**

Run: `docker compose -f infra/compose/postgres.compose.yaml up -d && pnpm migration:run && pnpm vitest run tests/control-plane/database-migration.spec.ts`

Expected: PASS and a healthy database container.

- [ ] **Step 5: Commit**

```bash
git add infra/compose apps/control-plane/src/database tests/control-plane/database-migration.spec.ts
git commit -m "feat: add durable control-plane schema"
```

### Task 3: Define Agent Protocol v1 as executable schemas

**Files:**
- Create: `packages/agent-protocol/src/schemas.ts`, `packages/agent-protocol/src/types.ts`, `packages/agent-protocol/src/index.ts`
- Create: `tests/contracts/agent-protocol.spec.ts`

**Interfaces:**
- Produces: `AgentManifestSchema`, `TaskEnvelopeSchema`, `TaskPlanSchema`, `AgentEventSchema`, `AgentResultSchema`, `ControlCommandSchema`.
- Produces: `validateTaskPlan(input: unknown, catalog: ReadyCapability[]): CompiledTaskPlan`.

- [ ] **Step 1: Write failing contract tests**

Use valid examples for `knowledge.retrieve` and invalid examples for an unknown capability, an input mapping that violates the selected agent schema, and a shared workspace without an explicit sharing group.

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `pnpm vitest run tests/contracts/agent-protocol.spec.ts`

Expected: FAIL because Protocol v1 is absent.

- [ ] **Step 3: Implement TypeBox schemas, inferred types, and compiler validation**

Fix the initial DAG node types to `agent_call`, `condition`, `approval`, and `end`. Permit an AI planner to compose arbitrary-sized graphs from these nodes, but require every `agent_call.capability` to be present in the ready catalog.

- [ ] **Step 4: Run contract tests and export JSON Schema artifacts**

Run: `pnpm vitest run tests/contracts/agent-protocol.spec.ts && pnpm protocol:export`

Expected: PASS; generated JSON Schema has no runtime-specific Codex or Pi fields.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-protocol tests/contracts
git commit -m "feat: define agent protocol v1"
```

### Task 4: Implement the read-only RAGFlow client and evidence mapping

**Files:**
- Create: `packages/ragflow-client/src/types.ts`, `packages/ragflow-client/src/client.ts`, `packages/ragflow-client/src/index.ts`
- Create: `tests/ragflow-client/client.spec.ts`

**Interfaces:**
- Produces: `RagflowClient.listDatasets(): Promise<RagflowDataset[]>`
- Produces: `RagflowClient.retrieve(request: RetrievalRequest): Promise<RagflowChunk[]>`
- Produces: `toEvidence(chunks: RagflowChunk[]): Evidence[]`

- [ ] **Step 1: Write failing HTTP-mocked client tests**

Assert `listDatasets` sends bearer authentication without exposing the token in thrown errors; assert retrieval posts `question`, at least one `dataset_ids`, `page=1`, `page_size`, and reads `data.chunks`; assert HTTP 200 plus business `code: 102` throws `RagflowBusinessError`.

- [ ] **Step 2: Run the RAGFlow client tests to verify they fail**

Run: `pnpm vitest run tests/ragflow-client/client.spec.ts`

Expected: FAIL because no client exists.

- [ ] **Step 3: Implement the client using native `fetch` and typed RAGFlow envelopes**

Use only `GET /api/v1/datasets` and `POST /api/v1/retrieval`. Resolve dataset IDs from `RAGFLOW_DATASET_IDS` when supplied; otherwise list accessible datasets. Map each returned chunk to protocol evidence with stable source, dataset, document, title, excerpt and similarity fields.

- [ ] **Step 4: Run client tests**

Run: `pnpm vitest run tests/ragflow-client/client.spec.ts`

Expected: PASS; logs and error messages contain endpoint metadata but never authorization content.

- [ ] **Step 5: Commit**

```bash
git add packages/ragflow-client tests/ragflow-client
git commit -m "feat: add read-only ragflow retrieval client"
```

### Task 5: Create the RAGFlow knowledge-agent package

**Files:**
- Create: `agents/ragflow-knowledge/agent.yaml`
- Create: `agents/ragflow-knowledge/schemas/input.schema.json`, `agents/ragflow-knowledge/schemas/result.schema.json`
- Create: `agents/ragflow-knowledge/src/{main,self-check,run-task,reporter}.ts`
- Test: `tests/agents/ragflow-knowledge.spec.ts`

**Interfaces:**
- Consumes: `TaskEnvelope`, `AgentEvent`, `AgentResult`, `RagflowClient`.
- Produces: CLI entry `runTask(envelope: TaskEnvelope, reporter: AgentReporter): Promise<AgentResult>` with capability `knowledge.retrieve`.

- [ ] **Step 1: Write failing knowledge-agent tests**

Test self-check without running retrieval, a normal query emitting ordered `started`, `progress`, `checkpoint`, and `completed` events, and an empty RAGFlow result producing a successful result with `evidence: []` and a `no_evidence` risk note.

- [ ] **Step 2: Run the agent tests to verify they fail**

Run: `pnpm vitest run tests/agents/ragflow-knowledge.spec.ts`

Expected: FAIL because the package is absent.

- [ ] **Step 3: Implement manifest, self-check, task worker, and signed callback reporter**

The self-check may verify configuration shape and reach `/api/v1/system/healthz`, but must not retrieve enterprise content. The worker may make read-only RAGFlow calls after it receives a leased TaskEnvelope. Its result must match the Protocol v1 evidence schema.

- [ ] **Step 4: Run agent tests and validate the manifest statically**

Run: `pnpm vitest run tests/agents/ragflow-knowledge.spec.ts && pnpm agent:validate agents/ragflow-knowledge/agent.yaml`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/ragflow-knowledge tests/agents/ragflow-knowledge.spec.ts
git commit -m "feat: add ragflow knowledge agent"
```

### Task 6: Build control-plane registration, approval, and internal event APIs

**Files:**
- Create: `apps/control-plane/src/{app.module.ts,main.ts}`
- Create: `apps/control-plane/src/config/auth.guard.ts`
- Create: `apps/control-plane/src/registry/{registry.module.ts,registry.service.ts,registry.controller.ts}`
- Create: `apps/control-plane/src/internal/instance-events.controller.ts`
- Test: `tests/control-plane/{registry.e2e-spec.ts,instance-events.e2e-spec.ts}`

**Interfaces:**
- Produces external APIs: `POST /v1/agents/discover`, `GET /v1/agents`, `POST /v1/agents/:agentId/versions/:version/approve`.
- Produces internal API: `POST /internal/v1/instances/:instanceId/events`.
- `RegistryService.discover(packagePath: string): Promise<PendingAgentVersion>` only reads `agent.yaml` and schemas.

- [ ] **Step 1: Write failing API tests**

Cover missing/incorrect bearer token, discovery of a valid manifest as `pending_review`, malformed manifest rejection, approval invoking a node-manager self-check request, and a callback with wrong lease token or duplicate sequence being rejected.

- [ ] **Step 2: Run API tests to verify they fail**

Run: `pnpm vitest run tests/control-plane/registry.e2e-spec.ts tests/control-plane/instance-events.e2e-spec.ts`

Expected: FAIL because the application has no modules or routes.

- [ ] **Step 3: Implement NestJS modules, token guard, registry state transitions, and idempotent event append**

Hash-compare the administrator bearer token. Discovery must parse only filesystem data. Approval changes a specific version from `pending_review` to `self_checking`; only a confirmed node-manager self-check promotes it to `ready`. Events are accepted only from an active attempt holding the current lease token.

- [ ] **Step 4: Run API and database tests**

Run: `pnpm vitest run tests/control-plane/registry.e2e-spec.ts tests/control-plane/instance-events.e2e-spec.ts`

Expected: PASS; unapproved packages have no process side effect.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src tests/control-plane
git commit -m "feat: add agent registry and event ingestion"
```

### Task 7: Implement the node manager and systemd process supervisor

**Files:**
- Create: `apps/node-manager/src/{app.module.ts,main.ts}`
- Create: `apps/node-manager/src/control/{control.controller.ts,control.service.ts}`
- Create: `apps/node-manager/src/supervisor/{supervisor.ts,systemd.supervisor.ts}`
- Create: `apps/node-manager/src/catalog/package-catalog.service.ts`
- Create: `infra/systemd/mg-node-manager.service`
- Test: `tests/node-manager/{control.spec.ts,systemd.supervisor.spec.ts}`

**Interfaces:**
- Produces: `ProcessSupervisor.start(spec: InstanceLaunchSpec): Promise<StartedInstance>` and `stop(instanceId: string): Promise<void>`.
- Produces internal APIs: `POST /internal/v1/self-checks`, `POST /internal/v1/instances`, `POST /internal/v1/instances/:id/stop`.

- [ ] **Step 1: Write failing supervisor and controller tests**

Inject a fake supervisor to prove start commands originate only from approved versions and a requested unit name is deterministic (`mg-agent-<instanceId>`). Verify self-check uses the manifest command only after approval and stop is idempotent.

- [ ] **Step 2: Run node-manager tests to verify they fail**

Run: `pnpm vitest run tests/node-manager/control.spec.ts tests/node-manager/systemd.supervisor.spec.ts`

Expected: FAIL because no node manager exists.

- [ ] **Step 3: Implement process supervision and protected internal control API**

Use `systemd-run` transient units under `root`, one unit per task instance, with unique working directory and environment file path. Restrict the node-manager listener to loopback and authenticate control-plane calls with a separate internal shared secret. Do not let a request provide arbitrary executable paths; resolve entry points from the approved package record.

- [ ] **Step 4: Run unit tests and a harmless systemd self-check integration test on 219**

Run: `pnpm vitest run tests/node-manager && pnpm node-manager:smoke-self-check ragflow-knowledge`

Expected: PASS; the transient self-check ends successfully and no business retrieval is made.

- [ ] **Step 5: Commit**

```bash
git add apps/node-manager infra/systemd tests/node-manager
git commit -m "feat: add node manager process control"
```

### Task 8: Add Codex-backed natural-language planning and safe plan compilation

**Files:**
- Create: `apps/control-plane/src/planner/{planner.module.ts,codex-app-server.runtime.ts,planner.service.ts,planner.prompt.ts}`
- Create: `apps/control-plane/src/tasks/compiler.ts`
- Test: `tests/control-plane/{planner.service.spec.ts,compiler.spec.ts,codex-app-server.runtime.spec.ts}`

**Interfaces:**
- Produces: `PlannerService.plan(request: TaskPlanningRequest, catalog: ReadyCapability[]): Promise<TaskPlanDraft>`.
- Produces: `CodexAppServerRuntime.runStructuredTurn(input: PlannerPrompt): Promise<unknown>`.
- Produces: `compilePlan(draft: unknown, catalog: ReadyCapability[]): CompiledTaskPlan`.

- [ ] **Step 1: Write failing runtime and compiler tests**

Mock app-server JSON-RPC lines to verify initialize, thread creation, turn completion and structured-plan extraction. Assert an arbitrary natural-language knowledge request can yield a valid one-node `knowledge.retrieve` plan; assert unknown capabilities, invalid schemas, cycles, and missing `end` nodes are rejected.

- [ ] **Step 2: Run planner tests to verify they fail**

Run: `pnpm vitest run tests/control-plane/planner.service.spec.ts tests/control-plane/compiler.spec.ts tests/control-plane/codex-app-server.runtime.spec.ts`

Expected: FAIL because no planner or runtime adapter exists.

- [ ] **Step 3: Implement Codex app-server transport, planner prompt, and compiler**

Spawn local `codex app-server` over stdio in the planner module. Give it a strict JSON-only plan schema, registered capability summaries, policy constraints and no direct shell tool instruction. Persist both the untrusted draft and compiler decision; only the compiled plan can advance to scheduling.

- [ ] **Step 4: Run tests and a manual planning smoke test with a non-sensitive query**

Run: `pnpm vitest run tests/control-plane/planner.service.spec.ts tests/control-plane/compiler.spec.ts tests/control-plane/codex-app-server.runtime.spec.ts && pnpm planner:smoke "查询企业知识库中已有的客户信息"`

Expected: PASS; the smoke result is a compiled graph and does not dispatch an agent.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/planner apps/control-plane/src/tasks/compiler.ts tests/control-plane
git commit -m "feat: add codex task planning and compilation"
```

### Task 9: Implement task dispatch, acceptance, and interruption recovery

**Files:**
- Create: `apps/control-plane/src/tasks/{tasks.module.ts,tasks.service.ts,tasks.controller.ts,recovery.service.ts}`
- Create: `apps/control-plane/src/acceptance/{acceptance.module.ts,acceptance.service.ts,acceptance.controller.ts}`
- Test: `tests/control-plane/{tasks.e2e-spec.ts,recovery.e2e-spec.ts,acceptance.e2e-spec.ts}`

**Interfaces:**
- Produces external APIs: `POST /v1/tasks`, `GET /v1/tasks/:taskId`, `POST /v1/tasks/:taskId/acceptance`.
- Produces: `TaskService.createAndPlan(input: CreateTaskInput): Promise<TaskRecord>` and `RecoveryService.recoverExpiredLeases(now: Date): Promise<RecoverySummary>`.

- [ ] **Step 1: Write failing end-to-end task tests**

Cover natural-language task creation, planner compilation, dispatch to node manager, persisted event timeline, `platform_auto` acceptance, `human_review` waiting state, human rejection without retry, a stale callback, and recovery after a simulated worker termination before completion.

- [ ] **Step 2: Run end-to-end tests to verify they fail**

Run: `pnpm vitest run tests/control-plane/tasks.e2e-spec.ts tests/control-plane/recovery.e2e-spec.ts tests/control-plane/acceptance.e2e-spec.ts`

Expected: FAIL because task orchestration is absent.

- [ ] **Step 3: Implement leasing, dispatch, result validation, acceptance and recovery**

Create a unique task workspace at `/home/middleground/data/workspaces/<task-id>`. Issue a fresh lease token for each attempt; only confirmed checkpoints may be resumed. Auto-accept only schema-valid evidence with sources and no unresolved agent risk. Human rejection records a terminal rejected result; retries require a new administrator request with a new attempt.

- [ ] **Step 4: Run end-to-end tests and the recovery fault-injection scenario**

Run: `pnpm vitest run tests/control-plane/tasks.e2e-spec.ts tests/control-plane/recovery.e2e-spec.ts tests/control-plane/acceptance.e2e-spec.ts`

Expected: PASS; exactly one accepted result exists after recovery and no old callback changes it.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/tasks apps/control-plane/src/acceptance tests/control-plane
git commit -m "feat: orchestrate and recover knowledge tasks"
```

### Task 10: Deploy the vertical slice to 219 and verify the real RAGFlow path

**Files:**
- Create: `infra/systemd/mg-control-plane.service`
- Create: `docs/runbooks/219-bootstrap-and-secrets.md`
- Create: `docs/runbooks/vertical-slice-verification.md`
- Modify: `README.md`
- Test: `tests/e2e/ragflow-vertical-slice.e2e-spec.ts`

**Interfaces:**
- Consumes the two systemd units, PostgreSQL Compose service, root-owned secrets file, and the approved `ragflow-knowledge` agent package.
- Produces a documented administrator flow from package discovery through accepted/reviewed knowledge result.

- [ ] **Step 1: Write the final external-contract test and verification checklist**

The test must verify bearer-auth rejection, static discovery before approval, successful post-approval self-check, a real read-only RAGFlow retrieval, result citation fields, task stop, and a no-secret scan of tracked files and service logs.

- [ ] **Step 2: Run the test to verify it fails before deployment**

Run: `pnpm vitest run tests/e2e/ragflow-vertical-slice.e2e-spec.ts`

Expected: FAIL because services are not installed.

- [ ] **Step 3: Deploy services and secure runtime configuration on 219**

Create `/home/middleground/.secrets/ragflow.env` and the separate control-plane/node-manager environment files with `root:root` ownership and mode `0600`; enter the supplied RAGFlow API key directly on the server, never through Git or task output. Start PostgreSQL through Compose, then enable and start only the two systemd services.

- [ ] **Step 4: Run real vertical-slice verification and failure checks**

Run: `pnpm test:e2e:219 && systemctl status mg-control-plane mg-node-manager --no-pager`

Expected: PASS; a natural-language query becomes a cited RAGFlow result, and no credentials appear in `git grep`, task events, or logs.

- [ ] **Step 5: Commit deployment material and tag the vertical slice**

```bash
git add infra/systemd docs/runbooks README.md tests/e2e
git commit -m "docs: document ragflow vertical slice deployment"
git tag v0.1.0-ragflow-vertical-slice
```

## Self-Review

- **Spec coverage:** Tasks 1–2 establish the required deployment and durable state; Tasks 3, 6, and 7 implement the protocol, registration, approval and process boundaries; Tasks 4–5 deliver real RAGFlow retrieval; Task 8 delivers AI natural-language planning; Task 9 delivers dispatch, task acceptance and recovery; Task 10 validates the complete 219 deployment. Email/Feishu ingress, extra agents, RAGFlow write operations, multi-node operation and stronger isolation remain intentionally outside this vertical slice.
- **Step scan:** Every task begins with a failing test, then names the exact command, interface and expected result before implementation and commit.
- **Type consistency:** `TaskEnvelope`, `TaskPlan`, `AgentEvent` and `AgentResult` are created in Task 3 and consumed unchanged thereafter. `RagflowClient` is created in Task 4, then injected only into the Task 5 worker.
- **Review focus:** Each listed risk is pinned to Tasks 4, 6, 8 or 9 as stated in the header.
- **Proportion:** This plan covers one independently testable vertical slice. Additional enterprise data sources, agent types and ingress channels require later plans rather than enlarging this foundation plan.
