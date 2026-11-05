# 流式今日总结弹窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击“生成今日总结”后立即打开弹窗，并把 OpenAI Responses 的增量内容安全渲染为 Markdown，同时修复分体按钮的箭头与圆角。

**Architecture:** Rust 网络层按行消费 SSE，OpenAI 客户端将文本增量交给总结命令，总结命令通过 Tauri Channel 向 React 发送事件并继续返回最终 `WorkSummary`。前端以明确的生成状态管理弹窗，使用 `react-markdown` 安全渲染流式缓冲；分体按钮将菜单定位容器与圆角裁切容器分离。

**Tech Stack:** Rust、reqwest blocking、Tauri 2 Channel、React 19、TypeScript、react-markdown、Vitest、Testing Library

**Spec:** `docs/superpowers/specs/2026-11-02-streaming-summary-dialog-design.md`

## Global Constraints

- 不允许模型输出的原始 HTML 直接注入页面。
- 命令仍返回最终 `WorkSummary`，保持复制、另存和知识库上传协议不变。
- 本次不实现取消后端请求；弹窗关闭后忽略晚到的流式事件。
- 生成完成前禁用复制、另存和上传操作。
- 保持现有文件选择、提示词和 RAGFlow 上传行为不变。

## Review Focus

- 服务返回合法 JSON 而非 SSE 时仍能生成最终总结，并补发一次完整文本增量。
- SSE 分片跨越网络读取边界时不得丢字、重复或打乱增量顺序。
- 用户关闭弹窗后，晚到的事件和最终 Promise 不得重新打开或更新弹窗。
- OpenAI 中途失败时保留已生成内容，弹窗切换为失败状态并展示可读错误。
- Markdown 中的原始 HTML 必须作为普通文本处理，不能创建可执行 DOM。

---

### Task 1: OpenAI SSE 增量解析与网络流读取

**Files:**
- Modify: `apps/desktop/src-tauri/src/network/http.rs`
- Modify: `apps/desktop/src-tauri/src/openai/client.rs`
- Test: `apps/desktop/src-tauri/src/openai/client.rs`

**Interfaces:**
- Consumes: OpenAI Responses `response.output_text.delta`、`response.completed`、`response.incomplete` 和错误事件。
- Produces: `OpenAiClient::generate_streaming<F>(..., on_delta: F) -> Result<SummaryGeneration, String>`，以及网络层逐行回调接口。

- [ ] **Step 1: Write failing Rust tests for ordered deltas, split SSE input, JSON fallback, failure after partial output, and incomplete status.**

- [ ] **Step 2: Run the focused OpenAI tests and verify the new tests fail because streaming callbacks do not exist.**

  Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml openai::client`

- [ ] **Step 3: Add a bounded, line-oriented bearer request in `network/http.rs` that streams successful response lines and buffers only non-success error bodies.**

- [ ] **Step 4: Implement an SSE accumulator in `openai/client.rs` and `generate_streaming` so each text delta is emitted exactly once while the final `SummaryGeneration` remains authoritative.**

- [ ] **Step 5: Run the focused Rust tests and verify they pass.**

- [ ] **Step 6: Commit the isolated streaming parser/network change if the worktree contains no unrelated user changes in those files.**

### Task 2: Tauri Channel 协议与 TypeScript 命令抽象

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/summary.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Test: `apps/desktop/src-tauri/tests/summary_command_test.rs`
- Test: `apps/desktop/src/features/today/today.test.tsx`

**Interfaces:**
- Consumes: Task 1 `OpenAiClient::generate_streaming`。
- Produces: Rust/TypeScript 对齐的 `WorkSummaryStreamEvent`：`started`、`delta`、`completed`；`QizhiCommands.generateWorkSummary(input, onEvent?)`。

- [ ] **Step 1: Write failing Rust serialization tests and TypeScript interaction tests for the three camelCase stream event variants.**

- [ ] **Step 2: Run the focused suites and confirm failures show the missing event protocol and callback parameter.**

  Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test summary_command_test`

  Run: `pnpm --filter @qizhi/desktop test -- --run src/features/today/today.test.tsx`

- [ ] **Step 3: Add `WorkSummaryStreamEvent` to Rust and send `started`, ordered `delta`, and `completed` events through `tauri::ipc::Channel` while retaining the command's final return value.**

- [ ] **Step 4: Import Tauri `Channel` in `tauri.ts`, add the matching TypeScript union, and adapt real and mocked command callers to accept an optional event callback.**

- [ ] **Step 5: Run both focused suites and verify they pass.**

- [ ] **Step 6: Commit the protocol change if doing so will not include unrelated user work.**

### Task 3: 立即弹窗、流式 Markdown 与分体按钮

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/SummaryResultDialog.tsx`
- Modify: `apps/desktop/src/App.css`
- Test: `apps/desktop/src/features/today/today.test.tsx`

**Interfaces:**
- Consumes: Task 2 `WorkSummaryStreamEvent` 和最终 `WorkSummary`。
- Produces: `SummaryDialogState`（`generating | completed | failed`、Markdown 缓冲、错误、模板与文件信息）以及安全渲染的总结弹窗。

- [ ] **Step 1: Add `react-markdown` and write failing React tests proving the dialog opens before the Promise resolves, deltas appear in order, actions are disabled until completion, Markdown creates semantic DOM, raw HTML is not injected, failures retain partial text, and close ignores late events.**

- [ ] **Step 2: Run the focused test and verify it fails for the current delayed `<pre>` implementation.**

  Run: `pnpm --filter @qizhi/desktop test -- --run src/features/today/today.test.tsx`

- [ ] **Step 3: Refactor `TodayPage.generateSummary` to create the dialog state synchronously, merge channel events, reconcile the final result, and guard closed/stale generations with an incrementing request token.**

- [ ] **Step 4: Refactor `SummaryResultDialog` to render generating/completed/failed states with `react-markdown`, safe links, auto-follow while the user remains near the bottom, and disabled completion actions during generation.**

- [ ] **Step 5: Split `.summary-action` from `.summary-split-button`, clip the inner 9px radius, make the arrow segment 40px with an 18px high-contrast SVG, and keep the menu outside the clipped container.**

- [ ] **Step 6: Run the focused React test and verify all assertions pass.**

- [ ] **Step 7: Commit the UI behavior and styling change if the commit can exclude unrelated user changes.**

### Task 4: 回归、可视验证与安装包

**Files:**
- Verify: `apps/desktop/src/**/*`
- Verify: `apps/desktop/src-tauri/src/**/*`
- Output: `apps/desktop/src-tauri/target/release/bundle/nsis/栖知_0.1.0_x64-setup.exe`

**Interfaces:**
- Consumes: Tasks 1–3 complete implementation。
- Produces: tested production build and current Windows installer.

- [ ] **Step 1: Run formatter, TypeScript, lint, frontend tests, and the complete Rust test suite.**

  Run: `pnpm --filter @qizhi/desktop check`

  Run: `pnpm --filter @qizhi/desktop test -- --run`

  Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

- [ ] **Step 2: Use the in-app Browser workflow to verify the split button geometry and the immediate modal/Markdown target flow; record any Tauri-only interaction that cannot be exercised in a browser fixture as residual risk.**

- [ ] **Step 3: Build the frontend and production Windows installer.**

  Run: `pnpm --filter @qizhi/desktop build`

  Run: `pnpm --filter @qizhi/desktop tauri build`

- [ ] **Step 4: Compute the installer's SHA-256 and report its absolute path, test results, and any remaining verification limitation.**
