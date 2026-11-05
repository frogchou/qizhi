# 今日总结设置与索引服务修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复重启后索引服务不可用，重做今日总结分段按钮，并将不限数量的提示词管理拆成独立设置区域。

**Architecture:** NTFS 服务安装配置改为 Windows 自动启动，并保持升级重启流程。提示词仍使用现有事务仓库，但移除总数上限；前端拆出独立 `SummarySettingsSection`，以紧凑可展开列表管理模板。今日页保留主操作加菜单语义，仅重构分段按钮结构和样式。

**Tech Stack:** Rust、Windows Service API、SQLite、Tauri 2、React 19、TypeScript、Vitest、Testing Library。

**Spec:** `docs/superpowers/specs/2026-11-02-summary-settings-and-indexer-fixes-design.md`

## Global Constraints

- 直接在当前 `main` 工作区开发，保留所有已有未提交改动，不自动提交或清理工作树。
- 提示词标题最多 60 字、正文最多 4000 字、标题唯一且恰好一个默认模板。
- 模板总数量不设产品上限；保存继续使用单事务整组替换。
- 不新增模型供应商，不改变现有 OpenAI 总结协议。

## Review Focus

- Windows 重启后服务必须自动运行，升级已有“手动”服务时也必须更新启动类型。
- 服务正常返回零条记录时必须得到 `ready` 空列表，而不是 `unavailable`。
- 保存超过 20 个模板后重新读取，数量和顺序必须完整保留。
- 删除或调整默认模板后仍必须恰好保留一个默认项。
- 分段按钮在禁用状态和窄窗口中不得断行、错位或出现两个独立圆角按钮。

---

### Task 1: NTFS 索引服务自动启动

**Files:**
- Modify: `apps/desktop/src-tauri/src/ntfs/windows_service.rs`
- Modify: `apps/desktop/src-tauri/tests/ntfs_installer_hook_test.rs`
- Test: `apps/desktop/src-tauri/src/commands/today.rs`

**Interfaces:**
- Consumes: 现有 `install_service()` 与 `restart_service(service)`。
- Produces: 安装及升级后启动类型为 `SERVICE_AUTO_START` 的 `QizhiNtfsIndexer`。

- [ ] **Step 1: Write failing installer test** — 断言安装函数使用 `SERVICE_AUTO_START`，不再使用 `SERVICE_DEMAND_START`。
- [ ] **Step 2: Run `cargo test --offline --test ntfs_installer_hook_test`** — 预期新断言失败。
- [ ] **Step 3: Replace both create/update service start types with `SERVICE_AUTO_START`**。
- [ ] **Step 4: Add/confirm zero-candidate snapshot regression test** — 服务返回成功但候选为空时，快照状态为 ready 且文件为空。
- [ ] **Step 5: Run installer and today command tests** — 预期通过。

### Task 2: 不限数量的独立提示词设置区

**Files:**
- Create: `apps/desktop/src/features/settings/SummarySettingsSection.tsx`
- Create: `apps/desktop/src/features/settings/SummarySettingsSection.test.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`
- Modify: `apps/desktop/src/App.css`
- Modify: `apps/desktop/src-tauri/src/database/repositories/summary_settings_repository.rs`
- Modify: `apps/desktop/src-tauri/tests/summary_settings_test.rs`

**Interfaces:**
- Consumes: `QizhiCommands.getSummarySettings/saveSummarySettings` 与现有模板契约。
- Produces: 独立、紧凑、可展开的 `SummarySettingsSection`；仓库可保存任意数量合法模板。

- [ ] **Step 1: Write failing repository test** — 保存并读回至少 25 个合法模板，断言数量、默认项和排序完整。
- [ ] **Step 2: Run `cargo test --offline --test summary_settings_test`** — 预期因 20 个上限失败。
- [ ] **Step 3: Remove only the total-template-count validation** — 保留单项长度、唯一标题、唯一排序和唯一默认项校验。
- [ ] **Step 4: Run repository test** — 预期通过。
- [ ] **Step 5: Write failing component tests** — 断言提示词区域不在 OpenAI 卡片内、默认紧凑、点击展开、可连续新增超过 20 项并保存。
- [ ] **Step 6: Extract `SummarySettingsSection` and move state/handlers from OpenAI card** — 使用行式摘要、展开编辑器、独立区块标题与操作栏。
- [ ] **Step 7: Add compact responsive styles and run settings tests/check** — 预期通过。

### Task 3: 今日总结分段按钮视觉修复

**Files:**
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes: 现有 `generateSummary`、`summaryMenuOpen` 与模板列表。
- Produces: 单一视觉容器内的主按钮和 SVG 下拉触发器。

- [ ] **Step 1: Write failing DOM test** — 分段控件有统一组语义，箭头为 SVG，主按钮文本不换行。
- [ ] **Step 2: Run today component test** — 预期因现有字符箭头和结构失败。
- [ ] **Step 3: Implement segmented control markup and CSS** — 固定 38px 高度、连续边界、34px 箭头区、统一禁用与悬停状态。
- [ ] **Step 4: Run today tests** — 预期通过。

### Task 4: Full verification and package

**Files:**
- Verify all modified files and generated NSIS artifact.

**Interfaces:**
- Consumes: Tasks 1–3 completed tree.
- Produces: verified installer for user testing.

- [ ] **Step 1: Run `cargo test --offline`**。
- [ ] **Step 2: Run frontend tests, TypeScript/ESLint/Prettier checks and production build**。
- [ ] **Step 3: Build NSIS installer and report absolute path, timestamp, size and SHA-256**。
