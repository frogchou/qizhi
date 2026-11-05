# 今日总结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户从“今日/过去”列表勾选文件，选择可配置的总结提示词，通过 OpenAI 生成 Markdown 总结，并可复制、另存或上传到 RAGFlow 知识库。

**Architecture:** 设置和提示词存入 SQLite；Rust 后端负责重新校验文件范围、抽取内容、调用 OpenAI Responses API，并在兼容性明确不足时执行一次本地文本回退；React 只管理选择、模板菜单和结果弹窗。生成结果不落库，保存和上传均由用户显式触发。

**Tech Stack:** Tauri 2、Rust、rusqlite、reqwest blocking、React 19、TypeScript、Vitest、Testing Library、RAGFlow HTTP API。

**Spec:** `docs/superpowers/specs/2026-10-30-today-summary-design.md`

## Global Constraints

- 保留主分支现有未提交改动，不重置、不覆盖无关功能。
- OpenAI、JEV、RAGFlow 密钥继续只保存在 Windows 凭据管理器，日志不得记录内容、路径、提示词、密钥或模型响应。
- 后端只接受文件 ID，并重新验证文件存在、扫描范围、排除目录和文件类型；不得信任前端路径。
- 单次最多 20 个文件、原始文件合计最多 40 MB；本地回退每文件最多 50,000 字符、合计最多 180,000 字符。
- 每项功能先写失败测试并观察失败，再实现最小通过代码。

## Review Focus

- 筛选后隐藏的已选项、刷新后失效的 ID，以及切换“今日/过去”时的选择状态。
- 代理返回含糊的 HTTP 400/404 时不得误触发本地回退；401/403/429/5xx/网络错误绝不回退。
- 用户勾选后文件被移动、删除或加入排除目录时，生成前必须阻止读取。
- 输出被截断时，弹窗、复制、保存和上传都必须保留明确警告。
- 必须在读取文件内容前完成数量和总大小上限校验。

---

## Task 1: 总结设置、提示词和数据库迁移

**Files:**
- Create: `apps/desktop/src-tauri/migrations/0008_summary_prompts.sql`
- Create: `apps/desktop/src-tauri/src/database/repositories/summary_settings_repository.rs`
- Modify: `apps/desktop/src-tauri/src/database/migrations.rs`
- Modify: `apps/desktop/src-tauri/src/database/mod.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/mod.rs`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`
- Test: `apps/desktop/src-tauri/tests/summary_settings_test.rs`
- Test: `apps/desktop/src-tauri/tests/database_migration_test.rs`

- [ ] 写迁移版本、五个默认提示词、模型默认值和读写验证的失败测试。
- [ ] 运行定向 Rust 测试并确认因缺少迁移/仓储而失败。
- [ ] 实现事务化的完整设置读取和保存，校验标题、提示词、默认项和模型名。
- [ ] 再次运行定向测试并通过。

## Task 2: OpenAI Responses 文件总结与严格回退

**Files:**
- Create: `apps/desktop/src-tauri/src/openai/mod.rs`
- Create: `apps/desktop/src-tauri/src/openai/client.rs`
- Create: `apps/desktop/src-tauri/src/openai/content.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/tests/openai_summary_test.rs`

- [ ] 为请求体、响应解析、截断输出和严格回退分类器编写失败测试。
- [ ] 运行定向测试并确认失败。
- [ ] 实现 Responses `input_file` Base64 请求、模型输出解析和不超过一次的兼容回退。
- [ ] 实现现代 Office/PDF/纯文本安全抽取；旧式二进制 Office 在直传不可用时返回可理解错误。
- [ ] 运行定向测试并通过。

## Task 3: Tauri 总结命令、保存和 RAGFlow 内存上传

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/summary.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/ragflow/client.rs`
- Test: `apps/desktop/src-tauri/tests/summary_command_test.rs`
- Test: `apps/desktop/src-tauri/src/ragflow/client.rs`

- [ ] 为文件 ID 校验、数量/大小限制、Markdown 保存和内存上传编写失败测试。
- [ ] 运行定向测试并确认失败。
- [ ] 实现获取/保存设置、生成总结、保存 Markdown、上传总结四组命令。
- [ ] 扩展 RAGFlow 客户端以字节流上传 Markdown，不创建临时文件。
- [ ] 运行定向测试并通过。

## Task 4: 设置页提示词管理

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`
- Modify: `apps/desktop/src/App.css`

- [ ] 编写新增、编辑、删除、排序、设为默认、模型设置和保存反馈的失败测试。
- [ ] 运行设置页测试并确认失败。
- [ ] 实现非技术化的提示词卡片编辑界面和模型字段。
- [ ] 运行设置页测试并通过。

## Task 5: 今日页选择、分裂按钮和总结结果弹窗

**Files:**
- Create: `apps/desktop/src/features/today/SummaryResultDialog.tsx`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/App.css`

- [ ] 编写受控复选框、仅全选可见项、切换页清空、模板菜单、生成状态和弹窗操作的失败测试。
- [ ] 运行今日页测试并确认失败。
- [ ] 实现选择状态、模板下拉总结按钮、生成进度和错误提示。
- [ ] 实现 Markdown 结果弹窗、复制、原生另存为和 RAGFlow 知识库上传。
- [ ] 运行今日页测试并通过。

## Task 6: 集成验证和安装包

**Files:**
- Modify if needed: `apps/desktop/e2e/today.spec.ts`
- Output: `apps/desktop/src-tauri/target/release/bundle/nsis/*.exe`

- [ ] 运行全部前端测试、Rust 测试和类型检查。
- [ ] 运行格式化、Clippy/构建检查并修复本功能引入的问题。
- [ ] 构建 Windows 安装包，核对文件时间、大小和哈希。
- [ ] 给出最新安装包的绝对可点击路径及已验证范围。
