# 今日目录屏蔽与知识库上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从今日文件条目实现即时目录屏蔽，以及经用户确认的单文件 RAGFlow 知识库上传与解析。

**Architecture:** Rust 后端扩展 Today 命令和 RAGFlow 客户端：前者以已选文件的父目录更新 `ScanRuleStore` 后重建快照，后者以 multipart 上传并可选发起解析。React 前端把两个动作加入现有右键菜单，上传以受控对话框完成，文件内容从不进入 WebView。

**Tech Stack:** Tauri 2、Rust、reqwest blocking multipart、React 19、TypeScript、Vitest、Cargo tests。

**Spec:** `docs/superpowers/specs/2026-10-30-today-directory-block-and-ragflow-upload-design.md`

## Global Constraints

- 只能在用户点击上传确认后读取和上传本地文件。
- 所有目录与文件校验必须经过现有 `ScanPolicy`；排除目录保存后立即过滤当前快照。
- 只使用 HTTP 库连接 RAGFlow；不启动命令行或 shell。
- 不记录 API Key、文件内容和完整第三方响应。
- 上传默认继承目标知识库解析策略；仅允许控制是否立即触发解析与可选知识库内目录。

## Review Focus

- 选择已被排除或不再允许的文件时，后端必须拒绝上传；Task 2 的 Rust 测试覆盖。
- 屏蔽目录时，父目录下的缓存记录必须立刻消失，其他目录不受影响；Task 1 的 Rust 测试覆盖。
- RAGFlow 返回上传成功却未提供文档 ID 时，不能尝试解析并必须报出可诊断错误；Task 2 的客户端测试覆盖。
- 用户取消对话框或没有选择知识库时，前端不能发起上传；Task 3 的 Vitest 覆盖。
- 上传成功、解析失败时，前端必须显示上传已完成但解析未启动的结果；Task 3 的 Vitest 覆盖。

---

### Task 1: 目录屏蔽后端命令

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/today.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/src/commands/today.rs`

**Interfaces:**
- Produces: `exclude_file_directory(state, id) -> Result<TodayReady, String>`。
- Consumes: `ScanRuleStore`, `ScanPolicy`, `FileRepository`, `IndexerRequestKind::Configure`。

- [ ] **Step 1: Write the failing Rust test**

Test a saved parent exclusion with files inside and outside it; assert the returned snapshot keeps only the file outside the blocked parent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline excludes_the_selected_file_parent_from_the_cached_today_snapshot`
Expected: FAIL because the command helper is missing.

- [ ] **Step 3: Implement the command and helper**

Persist a normalized selected file parent to `custom_exclusions`, de-duplicate it, best-effort configure the native indexer with saved rules, then return the current-day cached snapshot using the newly saved policy.

- [ ] **Step 4: Run Rust test to verify it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline excludes_the_selected_file_parent_from_the_cached_today_snapshot`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: exclude directories from today file menu`

### Task 2: RAGFlow single-file upload client and command

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/ragflow/client.rs`
- Modify: `apps/desktop/src-tauri/src/commands/knowledge.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/tests/ragflow_client_test.rs`

**Interfaces:**
- Produces: `RagflowClient::upload_document(path, dataset_id, parent_path, start_parse) -> RagflowUpload` and `upload_today_file(state, input) -> RagflowUploadOutput`.
- Consumes: `ScanPolicy` validation and file record ID selected by Task 3.

- [ ] **Step 1: Write failing Rust tests**

Cover parsing the documented upload response into document IDs, rejecting an upload response with no IDs when parsing was requested, and refusing an upload candidate outside policy.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --test ragflow_client_test`
Expected: FAIL because the upload contract is missing.

- [ ] **Step 3: Implement minimal upload contract**

Use reqwest multipart with Bearer authentication to upload the path only after policy validation. Parse only the document IDs and status needed by the UI; if enabled, start the documented dataset chunking endpoint for uploaded IDs.

- [ ] **Step 4: Run Rust tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --test ragflow_client_test`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: upload today files to ragflow datasets`

### Task 3: 今日右键菜单与上传确认对话框

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/App.css`
- Test: `apps/desktop/src/features/today/today.test.tsx`

**Interfaces:**
- Consumes: `excludeFileDirectory(id) -> TodaySnapshot`, `listRagflowDatasets()`, `uploadTodayFile({ fileId, datasetId, parentPath, startParse }) -> RagflowUpload`。

- [ ] **Step 1: Write failing Vitest tests**

Assert that the right-click menu exposes both commands, blocking replaces the view with the returned filtered snapshot, and upload requires dataset choice before invoking the backend.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run src/features/today/today.test.tsx`
Expected: FAIL because the menu and dialog actions do not exist.

- [ ] **Step 3: Implement menu and dialog**

Load datasets only when opening upload. Show chosen file metadata, target select, optional path, parse toggle, cancel and primary confirmation; maintain accessible labels and concise success/error notices.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- --run src/features/today/today.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add today file upload workflow`

### Task 4: Integrated verification

**Files:**
- Modify: `docs/superpowers/plans/2026-10-30-today-directory-block-and-ragflow-upload.md`

- [ ] **Step 1: Run frontend checks**

Run: `npm run check && npm run test -- --run`
Expected: PASS.

- [ ] **Step 2: Run Rust checks**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --lib && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --test ragflow_client_test`
Expected: PASS.

- [ ] **Step 3: Review the diff and commit verification records**

Run `git diff --check` and confirm no key/content leaks. Commit any final documentation update with `test: verify today directory block and ragflow upload`.
