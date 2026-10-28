# 今日文件内建发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让“今日”在没有 Everything 的情况下发现允许目录中当天修改的文件。

**Architecture:** 使用现有 `FileDiscovery` 接口新增受限递归文件系统实现，并由现有扫描服务继续负责安全复核与 SQLite 记录。Tauri 命令把同步扫描放入后台阻塞任务；Everything 保留为设置页的可选服务。

**Tech Stack:** Rust 2024、Tauri 2、SQLite、React 19、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-28-today-native-discovery-design.md`

## Global Constraints

- 不读取或上传文件内容；仅使用元数据。
- 不跟随重解析点，不扫描网络路径、系统路径、AppData 或用户排除目录。
- Windows 首发，非 Windows 构建必须保持安全。
- Everything 不再是“今日”功能的运行时依赖。

## Review Focus

- 目录遍历遇到无权限或瞬时消失的项时必须跳过而不是使全部刷新失败。
- 符号链接、联接点等重解析项不得被递归进入。
- 修改时间边界必须为本地当天的半开区间。
- 刷新命令不得在 UI 主线程执行长时间遍历。
- Everything 不可用时“今日”仍应返回可用快照。

### Task 1: 原生受限目录发现

**Files:**
- Create: `apps/desktop/src-tauri/src/discovery/native_fs.rs`
- Modify: `apps/desktop/src-tauri/src/discovery/mod.rs`
- Test: `apps/desktop/src-tauri/tests/native_file_discovery_test.rs`

- [ ] 写入临时目录测试：只返回区间内的常规文件，跳过目录与时间范围外文件。
- [ ] 运行测试并确认当前因类型缺失失败。
- [ ] 实现 `NativeFileDiscovery: FileDiscovery`。
- [ ] 运行测试确认通过。
- [ ] 提交。

### Task 2: 今日命令改用内建发现

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/today.rs`
- Modify: `apps/desktop/src-tauri/src/scan/service.rs`（如需注入测试发现器）
- Test: `apps/desktop/src-tauri/tests/scan_service_test.rs`

- [ ] 写入“Everything 不可用时仍可由本机发现器刷新”的失败测试。
- [ ] 运行测试确认失败。
- [ ] 将两个今日命令移入后台阻塞任务，并固定使用 `NativeFileDiscovery`。
- [ ] 运行对应测试与全量 Rust 测试。
- [ ] 提交。

### Task 3: 状态与回归验证

**Files:**
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Test: `apps/desktop/src/features/today/today.test.tsx`
- Test: `apps/desktop/e2e/today.spec.ts`

- [ ] 写入无结果时的明确文案与 Everything 可选说明的失败测试。
- [ ] 运行测试确认失败。
- [ ] 实现状态文案。
- [ ] 运行前端单测、端到端测试、Rust 全量测试和安装包构建。
- [ ] 提交。
