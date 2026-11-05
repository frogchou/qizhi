# Codex 阶段 C 资料交接与 RAGFlow 回传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通“今日/过去与知识库资料 → 指定 Codex 项目会话 → Codex 生成物上传 RAGFlow”的可靠闭环，并保证跨页面跳转、失败重试和应用重启不会丢失交接状态。

**Architecture:** Rust 通过 SQLite handoff 批次和项目内 staging 目录完成先落盘后导航的两阶段交接；React 共享一个目标选择弹窗，App 顶层只传 project/conversation/handoff ID 并切换页面。Codex turn 保留完整项目资料版本绑定，另用 handoff 关联记录本轮重点资料；生成物上传复用现有 `RagflowClient`，但从 artifact ID 安全解析路径并持久化上传状态。

**Tech Stack:** Tauri 2、Rust 2024、rusqlite、serde/serde_json、React 19、TypeScript 6、Vitest、Testing Library、现有 RAGFlow HTTP client 与 Codex app-server runtime。

**Spec:** `docs/superpowers/specs/2026-11-05-codex-stage-c-handoff-design.md`

## Global Constraints

- 只在当前 `main` 工作树开发，保留所有无关用户改动，不重置或清理现有文件。
- 页面跳转只传 `projectId`、`conversationId`、`handoffId`；正文和路径必须先由 Rust/SQLite 持久化。
- 交接成功前不跳转，Codex 任务不自动发送。
- Today 文件只能由数据库记录 ID/query ID 解析并重新应用扫描范围、排除目录与类型规则；前端不能提交任意本地路径。
- RAGFlow 完整文档必须由 Rust 重新下载；Agent 私有思考和执行轨迹不得进入资料。
- 运行中项目禁止导入、刷新、移除资料或上传可能仍变化的生成物。
- 所有项目路径由 Rust 从 project/artifact/material ID 解析；拒绝路径穿越、符号链接、junction 与 reparse point。
- 生成物上传必须由用户确认知识库、目录与是否解析；状态不确定时不得自动重试。
- 不引入 shell、PowerShell、cmd 或 curl；网络继续使用现有 Rust HTTP 层。

## Review Focus

- **重复确认与迟到响应：** 同一个 request ID 双击提交、来源页面已切换、Tauri Promise 迟到时只产生一个 ready handoff，且只导航一次（Task 2、Task 4 测试）。
- **来源在准备后变化：** 文件被删除、排除、重写或目录查询过期时提交失败并保留来源页选择，不导入旧路径（Task 2、Task 5 测试）。
- **跨会话串线：** 两个 handoff 同时指向不同会话时，Codex 页面只在各自会话展示和消费自己的重点资料（Task 7 测试）。
- **远程部分失败：** 多个 RAGFlow 文档中一个下载失败时整批不 ready、不跳转，staging 可恢复清理（Task 3、Task 10 测试）。
- **上传结果不确定：** 请求发出后连接中断时记录 `uncertain`，界面要求显式再次上传，不把本地生成物标成失败或删除（Task 8 测试）。

---

### Task 1: Handoff、重点资料与上传历史持久化

**Files:**
- Create: `apps/desktop/src-tauri/migrations/0012_codex_handoffs.sql`
- Modify: `apps/desktop/src-tauri/src/database/migrations.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/codex_repository.rs`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`
- Create: `apps/desktop/src-tauri/tests/codex_handoff_repository_test.rs`
- Modify: `apps/desktop/src-tauri/tests/database_migration_test.rs`

**Interfaces:**
- Consumes: `Database::codex()`、现有 project/conversation/material/version/turn/artifact 表。
- Produces: `CodexRepository::{create_handoff,mark_handoff_ready,mark_handoff_failed,find_handoff_by_request,list_pending_handoffs,dismiss_handoff_item,consume_handoffs,bind_turn_handoff,record_artifact_upload,list_artifact_uploads,recover_interrupted_handoffs}`；`CodexHandoff*`、`CodexArtifactUpload*` serde contracts。

- [x] **Step 1: 写失败的 migration/repository 测试**

覆盖：`request_id` 唯一；handoff conversation 必须属于 project；item material/version 必须属于同一 project；ready/dismissed/consumed 状态转换；两个会话 pending handoff 不串线；turn-handoff 绑定；artifact upload 的 uploaded/parse_failed/uncertain 状态；preparing 恢复为 failed；schema version 从 11 升为 12。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_repository_test --test database_migration_test`

Expected: FAIL，缺少 migration 与 repository 接口。

- [x] **Step 3: 实现 migration 与领域契约**

创建 `codex_handoffs`、`codex_handoff_items`、`codex_turn_handoffs`、`codex_artifact_uploads`；为 `codex_materials` 增加 `source_metadata_json TEXT`。handoff item 增加 `state CHECK(state IN ('ready','dismissed','consumed'))`，所有外键采用与现有项目删除语义一致的级联规则。

- [x] **Step 4: 实现 repository 事务与受控状态转换**

所有 ready 操作必须在单个事务写入 items、更新 material current version 和 handoff 状态；`consume_handoffs(turn_id, conversation_id, ids)` 校验全部 ready 且属于该会话后写 turn 关联并把未 dismissed item 标为 consumed。

- [x] **Step 5: 运行数据库测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_repository_test --test codex_repository_test --test database_migration_test`

Expected: PASS，schema version 为 12，旧 Codex 数据可迁移。

- [x] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/migrations/0012_codex_handoffs.sql apps/desktop/src-tauri/src/database apps/desktop/src-tauri/src/contracts.rs apps/desktop/src-tauri/tests/codex_handoff_repository_test.rs apps/desktop/src-tauri/tests/database_migration_test.rs
git commit -m "feat(codex): persist cross-page handoffs"
```

### Task 2: 本地文件交接准备、staging 与幂等提交

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/handoff.rs`
- Modify: `apps/desktop/src-tauri/src/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/codex/project_files.rs`
- Modify: `apps/desktop/src-tauri/src/codex/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/app_state.rs`
- Create: `apps/desktop/src-tauri/tests/codex_handoff_service_test.rs`

**Interfaces:**
- Consumes: Task 1 repository；现有 `WorkspaceQueryStore::resolve_selection`、scan rules/policy、`CodexProjectFiles`。
- Produces: `CodexHandoffService::{prepare_today,commit_local,recover}`；`CodexHandoffPreparationStore`；`CodexHandoffPreview`、`CommitCodexHandoffInput/Result`；`CodexRuntime::project_has_active_turn(project_id)`。

- [x] **Step 1: 写失败的本地交接测试**

测试单文件、多文件和目录选择被解析为稳定清单；prepare 后文件删除/内容变化/新增排除时 commit 拒绝；不同路径同内容保留两个 material；同一来源重复发送复用 material/version；相同 request ID 双提交返回同一 handoff；超过 50 MB 需要确认；旧 Office 是阻塞项；抽取失败现代文档需要 `confirm_original_only`；运行项目不可提交。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_service_test`

Expected: FAIL，handoff service 不存在。

- [x] **Step 3: 实现 preparation store 与不可伪造预览**

`prepare_today(query_id, file_ids, directory_ids) -> CodexHandoffPreview` 在 Rust 内保存带过期时间的来源快照，返回 `preparation_id`、数量、总大小、前五项、blocked/warning items；不复制文件。AppState 注入单例 store，过期 preparation 返回“请重新打开发送窗口”。

- [x] **Step 4: 扩展项目文件 staging API**

实现 `stage_handoff_files(project_id, handoff_id, sources, confirmations)`、`commit_staged_handoff(...)`、`discard_staging(...)`。复制前后校验 size/mtime，使用最终 SHA-256；拒绝 reparse point；所有文件成功后才移动到 materials 并调用 Task 1 ready 事务。

- [x] **Step 5: 实现 request ID 幂等与恢复**

commit 先查 request ID；已有 ready/consumed 直接返回原结果，preparing 返回进行中，failed 要求新 request ID。启动时将遗留 preparing 标记 failed 并清理对应 staging；清理不得遍历项目根之外。

- [x] **Step 6: 运行本地交接与原文件导入回归测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_service_test --test codex_project_files_test --test today_workspace_command_test`

Expected: PASS。

- [x] **Step 7: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/src/codex apps/desktop/src-tauri/src/app_state.rs apps/desktop/src-tauri/tests/codex_handoff_service_test.rs
git commit -m "feat(codex): stage local handoff materials"
```

### Task 3: RAGFlow 片段、原文档和 Agent 回答资料

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/ragflow_materials.rs`
- Modify: `apps/desktop/src-tauri/src/codex/handoff.rs`
- Modify: `apps/desktop/src-tauri/src/codex/mod.rs`
- Create: `apps/desktop/src-tauri/tests/codex_ragflow_handoff_test.rs`
- Modify: `apps/desktop/src-tauri/tests/ragflow_client_test.rs`

**Interfaces:**
- Consumes: Task 2 handoff staging；`RagflowClient::download_document`；现有 normalized chunks/references/sources。
- Produces: `CodexHandoffService::{prepare_ragflow_chunks,prepare_ragflow_document,prepare_ragflow_answer,commit_ragflow}`；受控 Markdown renderer。

- [x] **Step 1: 写失败的 RAGFlow 资料测试**

断言：chunk Markdown 包含 dataset/document/chunk ID、文档名、相关度和检索时间；每个 Agent 回答单独打包；回答只包含 question/final answer/references，不包含 steps/thinking；无引用回答带 `unverified_answer` 元数据；同一文档多引用只下载一次；一个文档下载失败时整批不 ready 且 staging 清理。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_ragflow_handoff_test`

Expected: FAIL，缺少 RAGFlow material renderer/service。

- [x] **Step 3: 实现受限输入与结构化 Markdown**

每批最多 100 个 chunk，每个正文最多 100,000 字符，每个回答最多 1 MiB；清理 multipart/control 字符但保留正常 Unicode。`source_metadata_json` 只写受控 ID、名称、相关度、Agent 名称、检索时间和验证状态。

- [x] **Step 4: 实现完整文档直接下载到 staging**

只接受通过 `is_resource_id` 的 dataset/document ID；下载内容先写项目 staging，随后复用 Task 2 哈希、抽取和原子提交。下载失败不产生 ready handoff。

- [x] **Step 5: 运行 RAGFlow 与 handoff 测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_ragflow_handoff_test --test ragflow_client_test`

Expected: PASS。

- [x] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/src/codex apps/desktop/src-tauri/tests/codex_ragflow_handoff_test.rs apps/desktop/src-tauri/tests/ragflow_client_test.rs
git commit -m "feat(codex): import RAGFlow materials"
```

### Task 4: Tauri commands、前端类型与可靠导航骨架

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/codex_handoff.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/tests/codex_handoff_commands_test.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Create: `apps/desktop/src/features/codex/CodexDestinationDialog.tsx`
- Create: `apps/desktop/src/features/codex/CodexDestinationDialog.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/app/App.test.tsx`
- Modify: `apps/desktop/src/features/codex/codex-dialog.css`

**Interfaces:**
- Consumes: Tasks 1–3 services。
- Produces: Tauri commands `prepare_codex_handoff`、`commit_codex_handoff`、`list_pending_codex_handoffs`、`dismiss_codex_handoff_item`；TS `CodexHandoffPreview/Result/SourceInput`；`CodexNavigationTarget`；共享 `CodexDestinationDialog`。

- [x] **Step 1: 写 command 参数与共享弹窗失败测试**

Rust 覆盖 preparation 不存在/过期、空选择、conversation 跨 project、归档目标、运行目标、重复 request ID。React 覆盖最近目标默认选中、切换项目刷新会话、原位新建项目/会话、blocked item 禁用确认、warning 确认、提交失败不调用导航、成功仅调用一次导航。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_commands_test`

Run: `pnpm --dir apps/desktop test -- CodexDestinationDialog.test.tsx App.test.tsx`

Expected: FAIL，commands/component 不存在。

- [x] **Step 3: 实现 commands 与 camelCase 类型适配器**

command 只接收受控 source union、preparation ID、目标 IDs、confirm flags 和 request ID；错误返回用户可理解中文，不泄漏绝对路径或正文。注册 handler 并更新 `QizhiCommands`/`tauriCommands`。

- [x] **Step 4: 实现统一目标弹窗**

弹窗内加载 active projects/conversations，以 repository 顺序选择最近目标；busy project 禁用；新建完成后留在弹窗并选中新目标。主按钮提交期间防双击；只有 commit 返回 ready result 才调用 `onCommitted(result)`。

- [x] **Step 5: 实现 App 顶层导航目标**

`App` 保存 `{projectId,conversationId,handoffId,nonce}`，把 `onOpenCodex` 传给 Today/Knowledge，把 `navigationTarget` 传给 CodexPage；收到成功结果后设置 route=`codex`。正文、路径和资料清单不得进入该 state。

- [x] **Step 6: 运行 commands、组件与构建检查**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_commands_test`

Run: `pnpm --dir apps/desktop test -- CodexDestinationDialog.test.tsx App.test.tsx && pnpm --dir apps/desktop check`

Expected: PASS。

- [x] **Step 7: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/src/commands apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/tauri.ts apps/desktop/src/App.tsx apps/desktop/src/app/App.test.tsx apps/desktop/src/features/codex
git commit -m "feat(codex): add reliable handoff navigation"
```

### Task 5: 今日/过去发送到 Codex

**Files:**
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/WorkspaceTreeTable.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes: Task 4 `CodexDestinationDialog`、`prepareCodexHandoff`、`onOpenCodex`；现有 workspace `queryId/fileIds/directoryIds` selection。
- Produces: 批量“发送到 Codex”、单文件右键入口、成功后选择清理与失败保留。

- [x] **Step 1: 写失败的 Today 交互测试**

覆盖：有文件/目录选择才启用批量按钮；右键单文件使用该 ID；today 与 recent sourceKind 正确；prepare 失败保留选择；commit 成功调用 `onOpenCodex` 并只清理已发送选择；提交期间切换 tab 不丢弹窗；目录 query 过期显示刷新提示。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --dir apps/desktop test -- today.test.tsx`

Expected: FAIL，入口和交接流程不存在。

- [x] **Step 3: 实现批量与右键入口**

复用现有选择集合，不在前端展开目录；调用 prepare 后打开共享弹窗。操作文案显示“发送到 Codex”，选择数与现有总结操作一致。

- [x] **Step 4: 实现来源页状态保护**

弹窗关闭不清选择；commit 失败显示错误并保留；成功后仅移除预览中已提交的 IDs，再通过 App callback 导航。防止迟到的旧 request 覆盖新弹窗。

- [x] **Step 5: 运行 Today 与 App 测试**

Run: `pnpm --dir apps/desktop test -- today.test.tsx App.test.tsx`

Expected: PASS。

- [x] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src/features/today apps/desktop/src/App.css
git commit -m "feat(today): send selected work to Codex"
```

### Task 6: 知识库问答发送到 Codex

**Files:**
- Modify: `apps/desktop/src/features/knowledge/KnowledgePage.tsx`
- Modify: `apps/desktop/src/features/knowledge/knowledge.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes: Task 4 shared dialog/commands/navigation；现有 `ConversationTurn` chunks、Agent final answer/references/sources。
- Produces: chunk 多选、完整文档发送、每个 Agent “发送此回答到 Codex”。

- [x] **Step 1: 写失败的知识库交互测试**

覆盖：片段多选发送；同文档引用去重；每个 Agent 按钮只发送自己的回答与引用；steps/thinking 不进入 command input；无引用回答显示警告仍可继续；无 document ID 时不显示“发送原文”；commit 失败不破坏现有问答和资源选择；成功后导航。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --dir apps/desktop test -- knowledge.test.tsx`

Expected: FAIL，发送入口不存在。

- [x] **Step 3: 实现三种来源入口**

引用片段列表增加 checkbox 与批量操作；source card 增加“发送原文”；每个 Agent answer 的 message actions 增加“发送此回答”。只传 Task 4 source union 需要的受限字段。

- [x] **Step 4: 保持知识库会话状态不变**

打开/关闭目标弹窗、交接失败和成功导航均不得清空 `turns`、selectedDatasetIds、selectedAgentIds、agentSessions 或 recentQueries；返回知识库页时原会话仍在。

- [x] **Step 5: 运行知识库与 App 测试**

Run: `pnpm --dir apps/desktop test -- knowledge.test.tsx App.test.tsx`

Expected: PASS。

- [x] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src/features/knowledge apps/desktop/src/App.css
git commit -m "feat(knowledge): send cited materials to Codex"
```

### Task 7: Codex 会话承接、重点资料与 turn 消费

**Files:**
- Modify: `apps/desktop/src/features/codex/CodexPage.tsx`
- Modify: `apps/desktop/src/features/codex/CodexConversation.tsx`
- Create: `apps/desktop/src/features/codex/CodexPendingMaterials.tsx`
- Modify: `apps/desktop/src/features/codex/CodexPage.test.tsx`
- Modify: `apps/desktop/src/features/codex/codex.css`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`
- Modify: `apps/desktop/src-tauri/src/codex/turns.rs`
- Modify: `apps/desktop/src-tauri/tests/codex_turns_test.rs`

**Interfaces:**
- Consumes: Task 1 pending handoffs/repository、Task 4 `navigationTarget`/commands。
- Produces: `StartCodexTurnInput.handoff_ids`；后台内部资料前缀；pending material chips；成功消费/失败保留。

- [x] **Step 1: 写失败的 turn 与会话承接测试**

Rust：handoff 必须属于 input conversation/project；内部 prompt 使用 derived path 优先并限制在 project root；DB user message仍是原始 prompt；turn 绑定全部可读 versions，并绑定重点 handoff；turn/start 拒绝或失败时 handoff 保持 ready；成功 start 后 consumed。React：navigation target 选择正确项目/会话；两个会话 pending 不串线；页面切换后 chips 保留；dismiss 只移除本轮重点；发送时携带正确 handoff IDs。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_turns_test`

Run: `pnpm --dir apps/desktop test -- CodexPage.test.tsx`

Expected: FAIL，handoff consumption/chips 不存在。

- [x] **Step 3: 扩展 start turn 的后端校验与内部 prompt**

从 ready handoff items 选择 derived/original snapshot 相对路径，构造不超过 32 KiB 的“本轮重点资料”内部前缀；只把原始 prompt 写入 user message。先校验 handoff 并保留 ready，再调用 Codex `turn/start`；服务确认启动成功后，在单个 DB 事务中写入/关联本地 turn、绑定 handoff 并标记 consumed。若该事务失败，立即请求中断刚启动的远端 turn、把本地 turn 记为 failed，并保持 handoff ready，避免资料被静默消费。

- [x] **Step 4: 实现 CodexPage 导航选择与 pending chips**

`navigationTarget.nonce` 只处理一次；切换目标后调用 `listPendingCodexHandoffs(conversationId)`。chips 位于 composer 上方，支持折叠和 dismiss；状态从后端读取，不把来源页 payload 缓存在组件。

- [x] **Step 5: 运行 Codex 后端和前端测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_turns_test --test codex_handoff_repository_test`

Run: `pnpm --dir apps/desktop test -- CodexPage.test.tsx`

Expected: PASS。

- [x] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/src/codex/turns.rs apps/desktop/src-tauri/src/contracts.rs apps/desktop/src-tauri/tests/codex_turns_test.rs apps/desktop/src/features/codex
git commit -m "feat(codex): consume handoffs in conversations"
```

### Task 8: Codex 生成物上传 RAGFlow

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/artifact_upload.rs`
- Create: `apps/desktop/src-tauri/src/commands/codex_artifacts.rs`
- Modify: `apps/desktop/src-tauri/src/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/tests/codex_artifact_upload_test.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Create: `apps/desktop/src/features/codex/CodexArtifactUploadDialog.tsx`
- Create: `apps/desktop/src/features/codex/CodexArtifactUploadDialog.test.tsx`
- Modify: `apps/desktop/src/features/codex/CodexContextPanel.tsx`
- Modify: `apps/desktop/src/features/codex/CodexPage.tsx`
- Modify: `apps/desktop/src/features/codex/codex-artifacts.css`

**Interfaces:**
- Consumes: Task 1 artifact upload repository；existing `RagflowClient::upload_document`；artifact safe path resolver。
- Produces: `upload_codex_artifact`、`list_codex_artifact_uploads` commands；上传确认 UI 与生成物状态。

- [x] **Step 1: 写失败的安全上传测试**

Rust 覆盖 artifact 不存在/跨项目/非 active/路径逃逸/reparse/文件 hash 已变化/项目运行中；成功记录 document IDs；parsing error 记录 `uploaded_parse_failed`；transport 在请求后中断记录 `uncertain`；同 hash 同 dataset 再传需要 `confirm_duplicate`。React 覆盖知识库、目录、解析开关、重复确认、成功/失败/uncertain 文案。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_artifact_upload_test`

Run: `pnpm --dir apps/desktop test -- CodexArtifactUploadDialog.test.tsx`

Expected: FAIL，artifact upload service/dialog 不存在。

- [x] **Step 3: 实现安全上传服务和 commands**

command 输入使用 artifact ID，不接受前端相对路径。上传前重算 hash 与 DB artifact 对比；调用现有 Rust multipart client。为该上传路径增加内部失败分类（至少区分“请求尚未发出”“请求可能已发出但未取得确定响应”“服务已明确返回失败”），据此写入 Task 1 的 failed/uncertain/uploaded 状态；不要求其他 RAGFlow 调用点改变公开错误类型。日志仅记录 artifact/upload ID、状态和数量。

- [x] **Step 4: 实现生成物上传界面**

生成物 action 增加“上传”；dialog 复用 datasets 获取，展示文件元数据、parent path 与 startParsing。项目运行时按钮禁用；成功后刷新该 artifact upload history 并显示目标知识库/解析状态。

- [x] **Step 5: 运行上传、RAGFlow 与前端测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_artifact_upload_test --test ragflow_client_test`

Run: `pnpm --dir apps/desktop test -- CodexArtifactUploadDialog.test.tsx CodexPage.test.tsx`

Expected: PASS。

- [x] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/src/codex apps/desktop/src-tauri/src/commands apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/codex_artifact_upload_test.rs apps/desktop/src/lib/tauri.ts apps/desktop/src/features/codex
git commit -m "feat(codex): upload artifacts to RAGFlow"
```

### Task 9: 资料来源状态、刷新与移除完善

**Files:**
- Modify: `apps/desktop/src-tauri/src/codex/handoff.rs`
- Modify: `apps/desktop/src-tauri/src/commands/codex_handoff.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/codex_repository.rs`
- Modify: `apps/desktop/src-tauri/tests/codex_handoff_service_test.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/features/codex/CodexContextPanel.tsx`
- Create: `apps/desktop/src/features/codex/CodexContextPanel.test.tsx`

**Interfaces:**
- Consumes: Task 2 staging/version flow、Task 3 RAGFlow document downloader、现有 remove material。
- Produces: `inspect_codex_material_sources`、`refresh_codex_material` commands；来源状态与刷新 UI。

- [x] **Step 1: 写失败的来源变化测试**

本地文件同 hash=unchanged、变更=source_changed、删除=source_missing；刷新创建新 version 且历史 turn 旧 version 可读；RAGFlow document 手动刷新下载新 version；chunk/answer 无刷新；运行项目禁止刷新/移除；前端正确显示来源、状态、刷新和确认。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_service_test`

Run: `pnpm --dir apps/desktop test -- CodexContextPanel.test.tsx`

Expected: FAIL，source inspection/refresh 不存在。

- [x] **Step 3: 实现来源检查与版本刷新**

检查只读取元数据/哈希，不自动替换；refresh 使用相同 staging/atomic version flow，并更新 current version。旧 snapshot 只有在无任何 turn/version 引用且由显式清理任务处理时才可删除，本阶段不自动清理。

- [x] **Step 4: 完善资料卡片交互**

显示来源类型、已准备/源变化/源缺失/仅原件；菜单提供刷新快照、查看来源、移除项目。刷新与移除均确认且在任务运行时禁用。

- [x] **Step 5: 运行后端与前端测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_service_test --test codex_repository_test`

Run: `pnpm --dir apps/desktop test -- CodexContextPanel.test.tsx CodexPage.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交本任务文件**

```bash
git add apps/desktop/src-tauri/src/codex/handoff.rs apps/desktop/src-tauri/src/commands/codex_handoff.rs apps/desktop/src-tauri/src/database/repositories/codex_repository.rs apps/desktop/src-tauri/tests/codex_handoff_service_test.rs apps/desktop/src/lib/tauri.ts apps/desktop/src/features/codex
git commit -m "feat(codex): refresh material source snapshots"
```

### Task 10: 跨页面集成、恢复与 Windows 安装包验收

**Files:**
- Create: `apps/desktop/e2e/codex-handoff.spec.ts`
- Modify: `apps/desktop/src/app/App.test.tsx`
- Modify: `docs/release/stage-0-1.md`
- Modify: `docs/superpowers/plans/2026-11-05-codex-stage-c-handoff.md`

**Interfaces:**
- Consumes: Tasks 1–9 全部 public commands/UI。
- Produces: 阶段 C 自动化证据与最新 NSIS 安装包。

- [ ] **Step 1: 写 fake command 端到端流程**

覆盖 Today 两文件 → 现有会话 → 跳转 → pending chips → 发送并消费；Knowledge chunk/document/answer → 新会话；返回来源页状态保持；生成 artifact → 上传 dataset；commit 失败不导航。

- [x] **Step 2: 写 Rust 重启与恢复集成测试**

模拟 preparing crash、ready handoff 重启、双 request、一个远程下载失败、turn/start 失败、artifact uncertain；断言 staging/DB/会话状态符合 spec。

- [x] **Step 3: 运行阶段 C 定向全套测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_handoff_repository_test --test codex_handoff_service_test --test codex_ragflow_handoff_test --test codex_turns_test --test codex_artifact_upload_test`

Run: `pnpm --dir apps/desktop test -- today.test.tsx knowledge.test.tsx CodexDestinationDialog.test.tsx CodexPage.test.tsx CodexContextPanel.test.tsx CodexArtifactUploadDialog.test.tsx App.test.tsx`

Expected: PASS。

- [x] **Step 4: 运行仓库级验证**

Run: `pnpm --dir apps/desktop check`

Run: `pnpm --dir apps/desktop test`

Run: `pnpm --dir apps/desktop build`

Run: `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml`

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: 所有非显式 ignored 测试通过；若仓库旧代码仍有 clippy 告警，记录为既有问题，本阶段新增文件不得产生新告警。

- [ ] **Step 5: 手工真实链路冒烟**

使用本机真实 NTFS 记录、本机 Codex 登录和配置的 RAGFlow：执行 Today 文件交接、知识片段交接、RAGFlow 原文下载、Codex 读取、生成 Markdown、上传知识库并解析。不得把测试敏感正文写入日志。

- [x] **Step 6: 构建并指纹 NSIS 安装包**

Run: `pnpm --filter @qizhi/desktop tauri build`

Expected: `apps/desktop/src-tauri/target/release/bundle/nsis/栖知_0.1.0_x64-setup.exe` 更新时间，记录绝对路径、字节数、时间和 SHA-256。

- [ ] **Step 7: 提交验收文件**

```bash
git add apps/desktop/e2e/codex-handoff.spec.ts apps/desktop/src/app/App.test.tsx docs/release/stage-0-1.md docs/superpowers/plans/2026-11-05-codex-stage-c-handoff.md
git commit -m "test(codex): verify stage C handoff workflow"
```
