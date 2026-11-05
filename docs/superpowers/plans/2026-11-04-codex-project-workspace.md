# Codex 项目工作区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在栖知桌面端实现可持久恢复的 Codex 项目、多个连续会话、受控资料快照、流式任务过程和生成物管理，形成阶段 A+B 的首个可用版本。

**Architecture:** React 工作台只操作版本化 Tauri commands；Rust 层负责 SQLite 项目模型、项目目录、资料快照和一个受管理的 Windows 原生 `codex app-server --stdio` 进程。每个会话映射一个 Codex thread，turn 事件经 Tauri Channel 流式返回；Codex 复用本机账号、MCP、Skills、插件和网络能力，同时把本地写入限制在项目 `workspace`，把选定资料放在只读 `materials`。

**Tech Stack:** Tauri 2、Rust 2024、rusqlite、serde/serde_json、Windows process APIs、React 19、TypeScript 6、Vitest、Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-04-codex-project-workspace-design.md`

## Global Constraints

- 只支持 Windows 原生 Codex；未安装时提供提示，不自动安装，不使用 WSL 或云端 Codex。
- 复用本机 Codex 登录和默认配置，不读取、复制或保存 Codex 凭据。
- 网络、MCP、Skills、插件、连接器和 Web 搜索沿用用户的 Codex 配置与原生审批机制。
- 本地文件操作只允许读取项目 `materials` 和读写项目 `workspace`；不能覆盖原资料或隐式放开父目录。
- 常见 PDF、DOCX、XLSX、PPTX、Markdown 和文本资料保存原件及可读派生快照；旧版 Office 二进制格式明确标为不支持。
- 首版不内置 Office 生成引擎；Codex 在 `workspace` 生成的正常文件均作为生成物管理。
- 每个项目同一时间最多一个运行中 turn；页面切换不能停止后台任务。
- 所有路径由 Rust 根据 project ID 解析；前端不能提交任意项目根目录。
- 不修改或清理当前工作树中与本功能无关的用户改动；提交时只暂存本任务的明确文件。

## Review Focus

- Codex 未安装、版本不支持或未登录时，页面必须给出可操作诊断，不能弹出命令行窗口或显示底层错误码（Task 3、Task 7）。
- JSONL 被拆包、多个响应与通知交错、子进程输出非 JSON 或进程中途退出时，事件不能串到错误会话，已有增量不能丢失（Task 3、Task 5）。
- 文件名重复、源文件变化、路径穿越、符号链接/junction/reparse point 和超大文件必须被安全处理，不能逃逸项目根（Task 2）。
- 页面切换、应用重启、thread 丢失和 turn 意外中断后，完整可见历史仍能展示，同时不能伪装成仍可延续的模型上下文（Task 4、Task 8、Task 11）。
- MCP/插件审批和命令/文件审批交错到达时，界面必须按 project/conversation/thread/turn/item 精确归属，并在用户决定后只响应一次（Task 5、Task 9）。

---

### Task 1: Codex 项目数据库与领域契约

**Files:**
- Create: `apps/desktop/src-tauri/migrations/0011_codex_projects.sql`
- Create: `apps/desktop/src-tauri/src/database/repositories/codex_repository.rs`
- Create: `apps/desktop/src-tauri/tests/codex_repository_test.rs`
- Modify: `apps/desktop/src-tauri/src/database/migrations.rs`
- Modify: `apps/desktop/src-tauri/src/database/mod.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/mod.rs`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`
- Modify: `apps/desktop/src-tauri/tests/database_migration_test.rs`

**Interfaces:**
- Consumes: 现有 `Database::{with_connection,with_transaction}` 和 migration runner。
- Produces: `Database::codex() -> CodexRepository`；`CodexRepository::{create_project,list_projects,rename_project,set_project_status,create_conversation,list_conversations,attach_thread,create_turn,append_message,upsert_process_item,complete_turn,record_material_version,list_materials,record_artifact,list_artifacts,record_approval}`；对应 serde contracts。

- [x] **Step 1: 写失败的 migration 与 repository 测试**

在 `codex_repository_test.rs` 固定以下断言：项目名 trim 后非空、项目按 `last_opened_at DESC` 返回、同项目会话标题可重复但 ID 唯一、thread 映射持久化、完整用户/助手消息和 process item 可重读、turn 可绑定多个 material version、归档项目不出现在默认列表。把 migration 测试期望版本从 `10` 改为 `11`。

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml codex_repository -- --nocapture`

Expected: FAIL，缺少 migration/repository/contracts。

- [x] **Step 3: 添加 schema 和 Rust contracts**

`0011_codex_projects.sql` 创建：`codex_projects`、`codex_conversations`、`codex_turns`、`codex_messages`、`codex_process_items`、`codex_materials`、`codex_material_versions`、`codex_turn_material_versions`、`codex_artifacts`、`codex_approval_records`、单行 `codex_preferences`；所有外键启用级联规则，项目/会话状态使用受控文本值，路径字段只保存项目内相对路径。偏好只保存 model ID 与 reasoning effort，不保存账号或凭据。

- [x] **Step 4: 实现 `CodexRepository` 的事务接口**

所有写入使用 `with_transaction`；ID 使用 `uuid::Uuid::new_v4()` 字符串，时间由调用者传入 UTC ms，列表查询返回稳定排序。向 `Cargo.toml` 添加 `uuid = { version = "1", features = ["v4"] }`。

- [x] **Step 5: 运行数据库测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_repository_test --test database_migration_test`

Expected: PASS，schema version 为 `11`。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/migrations/0011_codex_projects.sql apps/desktop/src-tauri/src/database apps/desktop/src-tauri/src/contracts.rs apps/desktop/src-tauri/tests/codex_repository_test.rs apps/desktop/src-tauri/tests/database_migration_test.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat(codex): add project workspace persistence"
```

### Task 2: 项目目录、资料版本与派生快照

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/mod.rs`
- Create: `apps/desktop/src-tauri/src/codex/project_files.rs`
- Create: `apps/desktop/src-tauri/src/codex/materials.rs`
- Create: `apps/desktop/src-tauri/tests/codex_project_files_test.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/jev/content.rs`
- Modify: `apps/desktop/src-tauri/src/jev/mod.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: Task 1 `CodexRepository` 和现有文档抽取能力。
- Produces: `CodexProjectFiles::new(root)`, `create_layout(project_id)`, `resolve_material_path`, `resolve_workspace_path`, `snapshot_local_files(project_id, paths) -> Vec<MaterialImportResult>`, `scan_artifacts(project_id) -> Vec<ArtifactSnapshot>`；`extract_document_text(path, max_chars) -> Result<String, ExtractionError>`。

- [ ] **Step 1: 写路径边界与导入失败测试**

覆盖：project ID 不得影响根路径；`..`、绝对相对路径、符号链接和 Windows reparse point 被拒绝；重名文件得到稳定短哈希后缀；复制期间失败不留下半文件；同内容去重；DOCX/XLSX/PPTX/PDF/MD/TXT 生成派生 `.md`；旧版 DOC/XLS/PPT 返回明确 unsupported；50 MB 文件先返回确认所需状态而非直接复制。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_project_files_test`

Expected: FAIL，`codex` module 不存在。

- [ ] **Step 3: 抽取通用文档解析接口**

把 `jev/content.rs` 中格式解析提取为可复用 `extract_document_text(path: &Path, max_chars: usize)`，JEV 保留 16,000 字符限制，Codex 资料派生允许更高但有明确上限；ZIP entry 总展开字节数必须受限。

- [ ] **Step 4: 实现项目目录与原子快照**

目录固定为 `<app-data>/codex-projects/<uuid>/{materials/local,materials/ragflow,workspace,previews}`。复制流程是临时文件→哈希→派生文本→原子重命名→数据库版本记录；向 `Cargo.toml` 添加 `sha2 = "0.10"`。

- [ ] **Step 5: 实现生成物安全扫描**

只遍历 `workspace` 普通文件，拒绝重解析点，返回相对路径、大小、mtime、SHA-256；不读取正文。

- [ ] **Step 6: 运行测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_project_files_test --test jev_value_test`

Expected: PASS，且原 JEV 测试不回归。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/codex apps/desktop/src-tauri/src/jev/content.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/codex_project_files_test.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat(codex): isolate project materials and artifacts"
```

### Task 3: Codex 检测与 app-server JSON-RPC 传输

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/protocol.rs`
- Create: `apps/desktop/src-tauri/src/codex/process.rs`
- Create: `apps/desktop/src-tauri/tests/codex_protocol_test.rs`
- Create: `apps/desktop/src-tauri/tests/codex_process_test.rs`

**Interfaces:**
- Consumes: 本机 `codex app-server --stdio` 和设计中的隐藏进程要求。
- Produces: `CodexInstallationProbe::detect() -> CodexInstallationStatus`；`AppServerProcess::{spawn,request,notify,subscribe,shutdown}`；`JsonRpcEnvelope`、`AppServerNotification`；稳定错误枚举 `CodexRuntimeError`。

- [ ] **Step 1: 写 JSONL 与进程探测失败测试**

使用假的子进程脚本覆盖：响应与通知交错、一次读取含多行、半行分两次读取、未知通知、stderr 噪声、非法 JSON、请求超时、进程退出、未安装、`codex --version` 非预期。断言未知通知被安全忽略，非法 JSON 产生诊断但不串线，所有 pending request 在进程退出时收到同一终止错误。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_protocol_test --test codex_process_test`

Expected: FAIL，缺少 process/protocol。

- [ ] **Step 3: 实现协议关联器**

请求 ID 使用单调递增 `u64`；一个 stdout reader thread 按行解析，响应发送到 `HashMap<id, Sender<_>>`，通知发送给订阅者；stderr 只进入脱敏诊断。最大单行 8 MiB，超过即终止该进程。

- [ ] **Step 4: 实现 Windows 隐藏进程和安装探测**

Windows `Command` 使用 `CREATE_NO_WINDOW`，固定 argv 而非 shell 字符串；先执行 `codex --version`，再启动 `codex app-server --stdio`。不要使用 PowerShell、cmd 或 curl。

- [ ] **Step 5: 运行协议与进程测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_protocol_test --test codex_process_test`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/codex/protocol.rs apps/desktop/src-tauri/src/codex/process.rs apps/desktop/src-tauri/tests/codex_protocol_test.rs apps/desktop/src-tauri/tests/codex_process_test.rs
git commit -m "feat(codex): add app server transport"
```

### Task 4: Runtime 生命周期、账号检测与 thread 恢复

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/runtime.rs`
- Create: `apps/desktop/src-tauri/tests/codex_runtime_test.rs`
- Modify: `apps/desktop/src-tauri/src/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/app_state.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 repository、Task 2 project files、Task 3 app-server transport。
- Produces: `CodexRuntime::{status,ensure_started,start_conversation_thread,resume_conversation_thread,fork_conversation,shutdown}`；`CodexRuntimeStatus { installation, account, sandbox, server }`；test-only `AppServerClient` trait/fake。

- [ ] **Step 1: 写 runtime 状态机测试**

固定序列：`initialize`→`initialized`→`account/read`→`windowsSandbox/readiness`。覆盖已登录直接可用、未登录 remediation、sandbox updateRequired、重复 start 只启动一个进程、崩溃后退避重启、thread/start 保存 ID、重启后 thread/resume、thread 不存在时保留历史并把会话标为 unavailable。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_runtime_test`

Expected: FAIL，缺少 runtime。

- [ ] **Step 3: 实现 `CodexRuntime`**

`CodexRuntime` 内部使用 `Arc<Mutex<RuntimeState>>`，不在锁内等待 RPC；启动、重启和 thread 操作必须幂等。复用默认 Codex 环境，不设置独立 `CODEX_HOME`，不读取凭据文件。测试必须断言 thread/turn 请求把 `cwd` 指向项目 `workspace`、`writableRoots` 只含该目录、`readOnlyAccess.readableRoots` 只含项目 `materials`，并保持网络及用户 Codex 扩展能力可用。

- [ ] **Step 4: 接入 `AppState` 生命周期**

在 Tauri setup 中创建 `<app-data>/codex-projects` 和 runtime；窗口关闭/应用退出时调用 `shutdown`，不杀死不属于栖知的 Codex 进程。

- [ ] **Step 5: 运行 runtime 测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_runtime_test`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/codex/runtime.rs apps/desktop/src-tauri/src/codex/mod.rs apps/desktop/src-tauri/src/app_state.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/codex_runtime_test.rs
git commit -m "feat(codex): manage threads and runtime recovery"
```

### Task 5: Turn 流式事件、审批、取消和生成物归档

**Files:**
- Create: `apps/desktop/src-tauri/src/codex/turns.rs`
- Create: `apps/desktop/src-tauri/tests/codex_turns_test.rs`
- Modify: `apps/desktop/src-tauri/src/codex/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`

**Interfaces:**
- Consumes: Task 4 runtime 和 Task 1/2 persistence/files。
- Produces: `CodexRuntime::{start_turn,interrupt_turn,resolve_approval}`；`CodexTurnEvent` tagged union；`StartCodexTurnInput`；`CodexTurnResult`。

- [ ] **Step 1: 写双会话交错事件测试**

用 fake app-server 交错发送两个 thread 的 message delta、reasoning summary、command execution、file change、MCP tool call、approval request 和 completion；断言按 thread/turn/item 精确路由、完成快照替换增量而非重复追加、私有 raw reasoning 不落库、同一 approval 只能决定一次。

- [ ] **Step 2: 写中断与崩溃测试**

覆盖 `turn/interrupt`、进程中途退出、页面订阅者断开、完成前生成文件。断言已有文本和过程卡片持久化，turn 状态分别为 interrupted/failed，artifact 扫描仍运行一次。

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_turns_test`

Expected: FAIL，缺少 turns/event contracts。

- [ ] **Step 4: 实现 turn 事件归一化和持久化**

只把 `item/reasoning/summary*` 映射为可见推理摘要；忽略 raw reasoning text。消息 delta 按 item ID 累积，`item/completed` 为权威快照；所有事件带 project/conversation/thread/turn/item 标识。

- [ ] **Step 5: 实现项目级串行、审批和完成核对**

每个 project 维护单一 active turn；审批响应使用 app-server 原生 decision；turn 完成/中断/失败后扫描 workspace 并记录 artifacts，然后释放项目锁。

- [ ] **Step 6: 运行 turn 测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_turns_test`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/codex/turns.rs apps/desktop/src-tauri/src/codex/runtime.rs apps/desktop/src-tauri/src/contracts.rs apps/desktop/src-tauri/tests/codex_turns_test.rs
git commit -m "feat(codex): stream turns approvals and artifacts"
```

### Task 6: Tauri Codex commands 与前端类型适配器

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/codex.rs`
- Create: `apps/desktop/src-tauri/tests/codex_commands_test.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/lib/contracts.ts`

**Interfaces:**
- Consumes: Tasks 1–5 Rust services。
- Produces: Tauri commands `get_codex_status`, `get_codex_preferences`, `save_codex_preferences`, `list_codex_projects`, `create_codex_project`, `rename_codex_project`, `archive_codex_project`, `delete_codex_project`, `list_codex_conversations`, `create_codex_conversation`, `rename_codex_conversation`, `archive_codex_conversation`, `fork_codex_conversation`, `read_codex_conversation`, `import_codex_materials`, `refresh_codex_material`, `remove_codex_material`, `start_codex_turn`, `interrupt_codex_turn`, `resolve_codex_approval`, `list_codex_artifacts`, `open_codex_artifact`, `reveal_codex_artifact`, `export_codex_artifact`；对应 `QizhiCommands` methods/types。

- [ ] **Step 1: 写 command 参数验证测试**

覆盖空名称、未知 project/conversation、跨项目 conversation ID、任意绝对 artifact 路径、重复 approval、运行中删除/刷新资料、运行中删除项目、非法 model/effort、未安装 Codex、未登录状态。错误返回稳定 `code/message/remediation`，不泄漏内部绝对路径和底层 stderr。项目删除先停止/拒绝活动任务，再将项目目录送入系统回收站；数据库只在文件操作成功后进入 deleted 状态。

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_commands_test`

Expected: FAIL，命令不存在。

- [ ] **Step 3: 实现 commands 并注册 handler**

所有命令只接受 ID 和用户选择器返回的资料路径；项目根和 artifact 路径由 Rust 解析。`start_codex_turn` 接收 `Channel<CodexTurnEvent>`，返回最终 `CodexTurnResult`。

- [ ] **Step 4: 添加 TypeScript contracts 与 invoke adapter**

`QizhiCommands` 增加与 Rust camelCase 完全一致的方法；`unavailableCommands` 返回明确不可用状态；资料选择使用 Tauri dialog `open({ multiple: true })`，生成物导出使用 `save()`。若使用 `trash` crate 实现回收站删除，将依赖加入此任务并用 Windows 集成测试验证，不得退化为静默永久删除。

- [ ] **Step 5: 运行 Rust 和 TypeScript 类型检查**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test codex_commands_test`

Run: `pnpm --dir apps/desktop build`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/codex_commands_test.rs apps/desktop/src/lib/tauri.ts apps/desktop/src/lib/contracts.ts
git commit -m "feat(codex): expose workspace commands"
```

### Task 7: Codex 设置与诊断区域

**Files:**
- Create: `apps/desktop/src/features/settings/CodexSettingsSection.tsx`
- Create: `apps/desktop/src/features/settings/CodexSettingsSection.test.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes: Task 6 `getCodexStatus()`。
- Produces: `CodexSettingsSection({ commands })`，展示安装、版本、账号、app-server、Windows sandbox、扩展能力、默认模型和推理强度。

- [ ] **Step 1: 写诊断 UI 失败测试**

测试：未安装显示“安装 Codex”指引；已安装未登录显示 `codex login` 指引；ready 显示版本和账号类型；sandbox updateRequired 显示修复提示；模型列表来自 Codex 能力结果，保存 model/effort 后重新打开仍保留；刷新只重新检测不打开命令行窗口。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --dir apps/desktop test -- CodexSettingsSection.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现独立 Codex 设置卡片**

替换当前 muted Codex 占位卡；使用现有设置页视觉语言，不显示凭据，不让用户填写第二套 Codex API Key。模型和 reasoning effort 选择只覆盖栖知创建的新 turn，不改写用户全局 `config.toml`。

- [ ] **Step 4: 运行设置测试**

Run: `pnpm --dir apps/desktop test -- CodexSettingsSection.test.tsx settings.test.tsx`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/settings/CodexSettingsSection.tsx apps/desktop/src/features/settings/CodexSettingsSection.test.tsx apps/desktop/src/features/settings/SettingsPage.tsx apps/desktop/src/App.css
git commit -m "feat(codex): add runtime diagnostics"
```

### Task 8: 项目/会话工作台骨架与持久导航

**Files:**
- Create: `apps/desktop/src/features/codex/CodexPage.tsx`
- Create: `apps/desktop/src/features/codex/CodexProjectSidebar.tsx`
- Create: `apps/desktop/src/features/codex/CodexPage.test.tsx`
- Create: `apps/desktop/src/features/codex/codex.css`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/app/App.test.tsx`

**Interfaces:**
- Consumes: Task 6 project/conversation commands。
- Produces: 持久挂载的 `CodexPage({ commands, hidden })`；project/session selection state；新建、重命名、归档 UI。

- [ ] **Step 1: 写项目导航和页面保持测试**

测试：空状态可新建项目；项目展开显示会话；选择在页面切换“今日→Codex 工作”后保留；项目按最近活动排序；归档后从默认列表消失；正在运行状态显示在对应会话上；Codex 页面隐藏时不出现在今日页面布局流中。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --dir apps/desktop test -- CodexPage.test.tsx App.test.tsx`

Expected: FAIL，仍显示 ComingSoon。

- [ ] **Step 3: 实现持久挂载工作台和左栏**

复用 KnowledgePage 的 `hidden` 持久挂载策略，但只在用户首次进入后挂载；三栏布局左栏 240–280px，中栏最小 520px，右栏 300–340px，小窗口允许收起侧栏而不产生页面横向滚动。

- [ ] **Step 4: 实现新建项目流程第一版**

弹窗包含名称、目标和可选初始文件；创建成功后自动创建第一个草稿会话并聚焦输入框。

- [ ] **Step 5: 运行 UI 测试**

Run: `pnpm --dir apps/desktop test -- CodexPage.test.tsx App.test.tsx`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/codex apps/desktop/src/App.tsx apps/desktop/src/app/App.test.tsx
git commit -m "feat(codex): add project conversation workspace"
```

### Task 9: 连续对话、流式过程与审批界面

**Files:**
- Create: `apps/desktop/src/features/codex/CodexConversation.tsx`
- Create: `apps/desktop/src/features/codex/CodexProcessCard.tsx`
- Create: `apps/desktop/src/features/codex/CodexApprovalCard.tsx`
- Create: `apps/desktop/src/features/codex/CodexConversation.test.tsx`
- Modify: `apps/desktop/src/features/codex/CodexPage.tsx`
- Modify: `apps/desktop/src/features/codex/codex.css`

**Interfaces:**
- Consumes: Task 6 turn commands/events 和 Task 8 selection state。
- Produces: 右对齐用户消息、左对齐 Codex Markdown、折叠过程卡、审批卡、固定 composer、停止与重试。

- [ ] **Step 1: 写流式 reducer 测试**

双会话交错事件不串线；delta 后 completed 不重复文字；页面切换后继续接收；向上滚动时不强拉到底；底部附近自动跟随；Enter 发送、Shift+Enter 换行、IME composing 不发送；编辑仅回填输入框；中断保留 partial。

- [ ] **Step 2: 写审批交互测试**

命令、文件、MCP 和网络审批显示动作与范围；同一 item 决定后按钮禁用；错误时可重试但不重复提交；未知审批类型显示安全的拒绝选项。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --dir apps/desktop test -- CodexConversation.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 4: 实现 conversation reducer 和 Markdown 渲染**

状态以 `conversationId/turnId/itemId` 为键，functional reducer 更新；使用现有 `react-markdown`，代码块和长单词必须换行，不允许横向撑破中栏。

- [ ] **Step 5: 实现过程卡、审批和 composer**

推理只显示 app-server reasoning summary；命令输出默认折叠并限制 UI 高度；固定输入框不覆盖最后一条消息。

- [ ] **Step 6: 运行对话测试**

Run: `pnpm --dir apps/desktop test -- CodexConversation.test.tsx`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/features/codex
git commit -m "feat(codex): stream conversations and approvals"
```

### Task 10: 资料与生成物右栏

**Files:**
- Create: `apps/desktop/src/features/codex/CodexContextPanel.tsx`
- Create: `apps/desktop/src/features/codex/CodexContextPanel.test.tsx`
- Modify: `apps/desktop/src/features/codex/CodexPage.tsx`
- Modify: `apps/desktop/src/features/codex/codex.css`

**Interfaces:**
- Consumes: Task 6 material/artifact commands。
- Produces: 资料/生成物 tabs、导入、版本状态、移除、打开、定位、另存操作和当前 Codex 扩展能力摘要。

- [ ] **Step 1: 写资料和生成物测试**

覆盖：多文件导入、同名结果、抽取失败提示、源文件变化、运行中禁止移除、资料版本信息、生成物长文件名省略、打开/定位/另存、未知格式使用系统打开；右栏本身滚动且不推动整个页面。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --dir apps/desktop test -- CodexContextPanel.test.tsx`

Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现上下文面板**

顶部显示 `项目资料 N 项 · 仅项目目录可写 · Codex 扩展能力已启用`；展开能力摘要列出 app-server 返回的 MCP/Skills/插件/网络状态，不把扩展数据误算为项目资料。

- [ ] **Step 4: 实现生成物操作**

内置预览仅覆盖 Markdown/文本/代码/常见数据文件；其他文件调用系统默认程序；导出必须经 save dialog 获取目标。

- [ ] **Step 5: 运行面板测试**

Run: `pnpm --dir apps/desktop test -- CodexContextPanel.test.tsx CodexPage.test.tsx`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/features/codex
git commit -m "feat(codex): manage materials and artifacts"
```

### Task 11: 集成、崩溃恢复与首个可用版本验收

**Files:**
- Create: `apps/desktop/e2e/codex.spec.ts`
- Create: `apps/desktop/src-tauri/tests/codex_recovery_test.rs`
- Modify: `apps/desktop/src/app/App.test.tsx`
- Modify: `apps/desktop/src/App.css`
- Modify: `docs/superpowers/specs/2026-11-04-codex-project-workspace-design.md`（仅更新实现状态，不改需求）

**Interfaces:**
- Consumes: Tasks 1–10 完整功能。
- Produces: 阶段 A+B 可验收构建和回归证据。

- [ ] **Step 1: 写 fake app-server 端到端夹具**

夹具模拟安装/登录状态、thread start/resume、三轮连续回答、命令审批、文件生成、turn interrupt 和进程崩溃；不依赖真实账号或网络。

- [ ] **Step 2: 写 Playwright 核心流程**

创建项目→导入资料→创建会话→发送三轮→批准一次操作→查看生成物→切换今日再返回→保持会话→重启页面后恢复。断言无横向滚动、输入框固定、资料与生成物独立滚动。

- [ ] **Step 3: 写崩溃与 thread 丢失 Rust 测试**

进程崩溃后 turn 标记 interrupted、历史可读、runtime 可重启；thread/resume 返回 not found 后会话标记 unavailable，用户可创建新会话，旧消息不删除。

- [ ] **Step 4: 运行定向全套测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml codex -- --nocapture`

Run: `pnpm --dir apps/desktop test -- codex App.test.tsx settings.test.tsx`

Run: `pnpm --dir apps/desktop e2e -- codex.spec.ts`

Expected: PASS。

- [ ] **Step 5: 运行仓库级验证**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Run: `pnpm --dir apps/desktop check`

Run: `pnpm --dir apps/desktop build`

Expected: 全部 PASS；若已有无关失败，记录命令、失败测试和与本改动无关的证据，不隐藏失败。

- [ ] **Step 6: 手工真实 Codex 冒烟测试**

在已安装并登录 Codex 的 Windows 测试机上验证：无额外登录、无命令行窗口、账号/MCP/Skills 可见、选定资料可读、workspace 可写、原件不变、网络能力遵循 Codex 审批。测试日志不得包含资料正文或凭据。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/e2e/codex.spec.ts apps/desktop/src-tauri/tests/codex_recovery_test.rs apps/desktop/src/app/App.test.tsx apps/desktop/src/App.css docs/superpowers/specs/2026-11-04-codex-project-workspace-design.md
git commit -m "test(codex): verify project workspace recovery"
```

## 后续阶段 C（独立计划）

阶段 A+B 验收后另写实施计划，覆盖：今日/过去列表“发送到 Codex 项目”、知识库引用与 RAGFlow 文档加入资料、Codex 生成物上传知识库。该阶段只复用本计划的 project/material/artifact interfaces，不改变 app-server 和会话模型。
