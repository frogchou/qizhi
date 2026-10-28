# RAGFlow Agents 与知识检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让栖知可靠反馈扫描规则状态，并在一个只读知识工作台中提供 RAGFlow 数据集检索和多 Agent 回答。

**Architecture:** 在现有 Rust `RagflowClient` 增加数据集、Agent、检索与原生 Agent 回答端口；Tauri 命令对查询聚合并隔离单 Agent 失败。React 以多选状态驱动同一次查询的检索结果和 Agent 结果。今日页把已在进行的扫描当作可观察状态而不是错误。

**Tech Stack:** Tauri 2、Rust、reqwest blocking、Serde、React 19、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-28-ragflow-agents-and-retrieval-design.md`

## Global Constraints

- Windows 首发；API Key 不写入日志、数据库、前端状态或命令行。
- RAGFlow 只读；不上传或修改数据集、文档、Agent 与会话。
- 检索最多展示 10 条片段；Agent 首发使用 `stream: false`，每轮新会话。

## Review Focus

- 保存规则失败必须保留编辑中的路径并显示失败原因。
- 已在运行的扫描完成后必须刷新缓存，而不是留下失败通知。
- 新排除目录必须同时过滤新扫描和旧缓存记录。
- Agent 列表中的非 Agent canvas 项不得出现在选择器中。
- 一个 Agent 请求失败时，其余 Agent 结果与检索结果仍应可见。

---

### Task 1: 扫描规则反馈与并发扫描状态

**Files:**
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`

**Interfaces:**
- Produces a visible scan-rule save status and a Today-page recovery path for the existing `refreshToday()` command.

- [ ] Write failing UI tests for successful scan-rule feedback and an already-running refresh that ends by rereading the snapshot.
- [ ] Run the focused Vitest files; expect the new assertions to fail.
- [ ] Implement the minimal save status and in-progress scan recovery without changing scan permissions.
- [ ] Run focused Vitest files; expect pass.
- [ ] Commit `fix: report scan rule saves and active scans`.

### Task 2: RAGFlow retrieval and Agent client contract

**Files:**
- Modify: `apps/desktop/src-tauri/src/ragflow/client.rs`
- Modify: `apps/desktop/src-tauri/tests/ragflow_client_test.rs`

**Interfaces:**
- Produces `list_datasets() -> Result<Vec<RagflowDataset>, String>`, `list_agents() -> Result<Vec<RagflowAgent>, String>`, `retrieve(question, dataset_ids) -> Result<Vec<RagflowChunk>, String>`, and `ask_agent(agent_id, question) -> Result<RagflowAgentAnswer, String>`.

- [ ] Write failing parser/request-shape tests for documented array datasets, `canvas` Agents, retrieval chunks and native non-stream Agent answer.
- [ ] Run the focused Rust test; expect missing client APIs or parser failures.
- [ ] Implement the client APIs with envelope and HTTP validation.
- [ ] Run the focused Rust test; expect pass.
- [ ] Commit `feat: add ragflow retrieval and agent client`.

### Task 3: Tauri query aggregation and typed desktop contract

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/knowledge.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Test: `apps/desktop/src-tauri/tests/ragflow_client_test.rs`

**Interfaces:**
- Produces `list_ragflow_datasets`, `list_ragflow_agents`, and `query_ragflow_knowledge({ question, datasetIds, agentIds })` returning retrieval chunks plus per-Agent result/error.

- [ ] Write failing command-level parsing/aggregation tests for partial Agent failure.
- [ ] Run focused Rust tests; expect missing commands/output types.
- [ ] Implement isolated per-Agent results and register the commands.
- [ ] Run focused Rust tests; expect pass.
- [ ] Commit `feat: expose ragflow knowledge workspace commands`.

### Task 4: Multi-select knowledge workspace UI

**Files:**
- Modify: `apps/desktop/src/features/knowledge/KnowledgePage.tsx`
- Modify: `apps/desktop/src/features/knowledge/knowledge.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes Task 3 contracts and produces datasets/Agents multi-select controls, one query action, retrieval cards, and independent Agent answer cards.

- [ ] Write failing UI tests for loading lists, multi-selection, request payload, retrieval display and a partial Agent error.
- [ ] Run focused Vitest test; expect old Chat Assistant UI assertions to fail.
- [ ] Replace the Chat Assistant UI with the selected workspace flow and compact result layout.
- [ ] Run focused Vitest test; expect pass.
- [ ] Commit `feat: add multi-agent knowledge workspace`.

### Task 5: Full verification and Windows installer

**Files:**
- Modify: none unless verification identifies a defect.

- [ ] Run Rust full suite and frontend test/check suite.
- [ ] Build the Windows NSIS installer and verify the installer timestamp changes.
- [ ] Commit only required verification fixes.
