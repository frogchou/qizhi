# Knowledge Conversation Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the RAGFlow knowledge page into a responsive chat interface with native Agent streaming, safe collapsed execution steps, per-Agent sessions, copy/edit-to-composer actions, and standard keyboard behavior.

**Architecture:** Rust assembles and parses native RAGFlow SSE frames, runs retrieval and deduplicated Agents concurrently, and emits typed Tauri Channel events while returning an authoritative final snapshot. React reduces those events into turn-local Agent state, renders Markdown chat messages, and keeps raw Markdown for copy and edit-to-composer without changing history or sessions.

**Tech Stack:** Rust 2024, reqwest blocking client, Tauri 2 Channel, React 19, TypeScript, react-markdown, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-knowledge-conversation-streaming-design.md`

## Global Constraints

- Work on the user-authorized `main` branch and preserve every unrelated dirty-worktree change.
- Credentials remain Rust-only; logs must not contain question text, answer text, trace payloads, or keys.
- The UI exposes verified RAGFlow execution steps only, never private chain-of-thought text.
- Retrieval and Agents fail independently; partial answers and sources remain usable.
- Raw Markdown is retained for copy/edit while rendered output disables raw HTML.
- TDD applies to every behavior change; no production implementation precedes its failing test.

## Review Focus

- A malformed or mislabeled SSE/JSON response must fail clearly without unbounded buffering or leaking partial private reasoning.
- Interleaved events from multiple Agents, duplicate Agent IDs, and late events after the final snapshot must not cross-contaminate or duplicate answers.
- Session invalidation clears only the affected Agent's continuation state and never silently retries the current question.
- IME composition, Shift+Enter, and a user reading above the bottom must not trigger accidental send or forced scrolling.
- Narrow windows and very long unbroken Markdown/trace text must wrap without horizontal overflow.

---

### Task 1: Native RAGFlow stream parser

**Files:**
- Modify: `apps/desktop/src-tauri/src/network/http.rs`
- Modify: `apps/desktop/src-tauri/src/ragflow/client.rs`
- Modify: `apps/desktop/src-tauri/tests/ragflow_client_test.rs`

**Interfaces:**
- Consumes: saved RAGFlow Base URL/API key and `HttpClient` request primitives.
- Produces: `RagflowClient::ask_agent_streaming(agent_id, question, session_id, on_event) -> Result<RagflowAgentAnswer, String>` and safe `RagflowAgentStreamEvent` values.

- [ ] **Step 1: Write failing parser tests** for multiline SSE data, heartbeat, `[DONE]`, top-level session IDs, business errors, interrupted streams, thinking start/end/missing-end/`<think>`, `node_finished` plus `component_finished`, multiple message IDs, and old single-JSON fallback with a size limit.
- [ ] **Step 2: Run** `cargo test --test ragflow_client_test --manifest-path apps/desktop/src-tauri/Cargo.toml` and verify the new tests fail because streaming interfaces/behavior do not exist.
- [ ] **Step 3: Implement** bounded SSE frame assembly in `HttpClient`, the Agent stream state machine, safe trace whitelisting/redaction, session extraction, and JSON fallback.
- [ ] **Step 4: Run the same Rust test command** and verify all parser tests pass.
- [ ] **Step 5: Commit only Task 1 files** with message `feat: stream ragflow agent responses`.

### Task 2: Concurrent knowledge command and typed Channel contract

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/knowledge.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Create: `apps/desktop/src-tauri/tests/knowledge_streaming_command_test.rs`

**Interfaces:**
- Consumes: Task 1 `ask_agent_streaming` and `RagflowAgentStreamEvent`.
- Produces: `query_ragflow_knowledge(input, on_event)` with `agentSessions`, typed `KnowledgeQueryStreamEvent`, `retrievalError`, per-Agent `sessionId/sessionInvalid/steps`, and an authoritative final snapshot.

- [ ] **Step 1: Write failing command/contract tests** for retrieval/Agent partial failures, duplicate Agent de-duplication, per-Agent session forwarding, worker failure, and event/final-snapshot convergence.
- [ ] **Step 2: Run** `cargo test --test knowledge_streaming_command_test --manifest-path apps/desktop/src-tauri/Cargo.toml` and verify failure is due to the missing streaming command contract.
- [ ] **Step 3: Implement** concurrent retrieval and Agent workers, Channel event emission, safe join failure conversion, terminal `completed`, and TypeScript Channel wiring.
- [ ] **Step 4: Run the task test plus** `pnpm --dir apps/desktop exec tsc --noEmit` and verify both pass.
- [ ] **Step 5: Commit only Task 2 files** with message `feat: stream knowledge query events`.

### Task 3: Chat reducer and interaction behavior

**Files:**
- Modify: `apps/desktop/src/features/knowledge/KnowledgePage.tsx`
- Modify: `apps/desktop/src/features/knowledge/knowledge.test.tsx`

**Interfaces:**
- Consumes: Task 2 `RagflowKnowledgeQuery`, `KnowledgeQueryStreamEvent`, and callback-enabled command.
- Produces: turn-local streaming state, terminal late-event guards, Agent session continuation, message copy/edit-to-composer, Enter/Shift+Enter/IME behavior, and near-bottom-only auto-scroll.

- [ ] **Step 1: Write failing component tests** for right/left alignment semantics, immediate streamed deltas, two interleaved Agents, no final duplication, late-event ignore, per-Agent sessions, session invalidation, copy raw Markdown, edit replacing the composer without changing history, Enter send, Shift+Enter newline, IME guard, and no forced scroll when reading above.
- [ ] **Step 2: Run** `pnpm --dir apps/desktop test --run src/features/knowledge/knowledge.test.tsx` and verify the new tests fail for missing behavior.
- [ ] **Step 3: Implement** functional event reducers and the chat message/composer behavior with `react-markdown`.
- [ ] **Step 4: Re-run the component test** and verify it passes without warnings.
- [ ] **Step 5: Commit only Task 3 files** with message `feat: add streaming knowledge chat interactions`.

### Task 4: Chat visual system and end-to-end verification

**Files:**
- Modify: `apps/desktop/src/App.css`
- Modify: `apps/desktop/e2e/knowledge.spec.ts`

**Interfaces:**
- Consumes: Task 3 semantic classes, message actions, details section, and composer behavior.
- Produces: polished right-aligned user bubbles, left-aligned answers, hover/focus actions, collapsed execution details, fixed composer, responsive wrapping, and visual regression coverage.

- [ ] **Step 1: Write failing Playwright assertions** for alignment, collapsed execution process, composer keyboard flow, persistent history after edit-to-composer, and no horizontal overflow at a narrow viewport.
- [ ] **Step 2: Run** `pnpm --dir apps/desktop e2e -- knowledge.spec.ts` and verify the new assertions fail against the current layout.
- [ ] **Step 3: Implement** the scoped knowledge-chat CSS and adjust the E2E harness only where required to emit realistic streaming events.
- [ ] **Step 4: Run** the focused Playwright test, then `pnpm --dir apps/desktop test --run`, `pnpm --dir apps/desktop check`, `pnpm --dir apps/desktop build`, and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`; verify all pass.
- [ ] **Step 5: Commit only Task 4 files** with message `style: refine knowledge conversation layout`.
