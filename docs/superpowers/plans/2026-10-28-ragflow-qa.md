# RAGFlow 知识库问答 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在栖知中选择已有 RAGFlow 问答机器人并完成一次只读问答。

**Architecture:** Rust 后端读取掩码配置和 Windows 凭据，使用独立 `RagflowClient` 执行安全的非流式 HTTP 调用；Tauri 命令只暴露机器人列表和问答结果。React 设置页保存连接，知识库页管理机器人选择、问题与回答状态。

**Tech Stack:** Tauri 2、Rust、`curl.exe` 标准输入、Serde、React 19、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-28-ragflow-qa-design.md`

## Global Constraints

- Windows 原生首发；API Key 不写入日志、数据库或命令行。
- 仅支持 HTTP/HTTPS Base URL；首发使用非流式只读问答。
- 不上传文件、不修改 RAGFlow 数据集、机器人或会话。

## Review Focus

- 未配置 RAGFlow 时，知识库页提供设置入口而不崩溃（Task 3）。
- API 返回 HTTP 200 但业务 `code` 非 0 时，展示失败而不把其当作回答（Task 2）。
- API Key 中的特殊字符不会进入命令行或页面状态（Task 1/2）。
- 空机器人列表和空回答有明确提示（Task 3）。
- 切换机器人后不得把上一个机器人的回答继续当作当前答案（Task 3）。

---

### Task 1: RAGFlow 配置与凭据读取

**Files:**
- Modify: `apps/desktop/src-tauri/src/config/secret_store.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/config_repository.rs`
- Modify: `apps/desktop/src-tauri/src/commands/settings.rs`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Test: `apps/desktop/src-tauri/tests/config_security_test.rs`
- Test: `apps/desktop/src/features/settings/settings.test.tsx`

**Interfaces:**
- Produces `service == "ragflow"` masked configuration and a secret lookup usable only by backend services.

- [ ] Write failing tests for masked RAGFlow save and a disabled test button until both fields are present.
- [ ] Run focused Rust and Vitest tests; expect missing RAGFlow UI/config support.
- [ ] Implement generic secret retrieval, RAGFlow endpoint validation, masked settings UI, and safe connection-test command.
- [ ] Run focused tests; expect pass.
- [ ] Commit `feat: configure ragflow connection`.

### Task 2: Read-only RAGFlow client and Tauri commands

**Files:**
- Create: `apps/desktop/src-tauri/src/ragflow/client.rs`
- Create: `apps/desktop/src-tauri/src/ragflow/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/knowledge.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/tests/ragflow_client_test.rs`

**Interfaces:**
- Produces `list_ragflow_chats() -> Result<Vec<RagflowChat>, String>` and `ask_ragflow_chat(chat_id, question) -> Result<RagflowAnswer, String>`.

- [ ] Write failing parser tests covering success, RAGFlow business failure, and missing answer.
- [ ] Run focused Rust test; expect unresolved RAGFlow module/functions.
- [ ] Implement `RagflowClient` using stdin-fed curl configuration; validate both HTTP and envelope code; add list/ask commands.
- [ ] Run focused test; expect pass.
- [ ] Commit `feat: add ragflow qa client`.

### Task 3: Knowledge-base question UI

**Files:**
- Create: `apps/desktop/src/features/knowledge/KnowledgePage.tsx`
- Create: `apps/desktop/src/features/knowledge/knowledge.test.tsx`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes the Task 2 list/ask Tauri contracts.
- Produces the interactive “知识库” route.

- [ ] Write failing UI tests for assistant selection, sending a question, and configuration-required state.
- [ ] Run focused Vitest test; expect the placeholder route to fail assertions.
- [ ] Implement the non-streaming selection and question UI with loading/error states; never persist answer text locally.
- [ ] Run focused test; expect pass.
- [ ] Commit `feat: add ragflow knowledge qa page`.

### Task 4: Full verification and release

**Files:**
- Modify: none unless verification discovers a defect.

- [ ] Run `cargo test --locked --offline -- --test-threads=1` in `apps/desktop/src-tauri`.
- [ ] Run `pnpm --filter @qizhi/desktop test -- --run`, `check`, and `e2e`.
- [ ] Build the Windows NSIS installer and verify bundled resources.
- [ ] Commit only required verification fixes.
