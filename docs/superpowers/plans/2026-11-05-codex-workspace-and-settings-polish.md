# Codex Workspace and Settings Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe project/conversation deletion and polish the Codex destination, workspace menu, and scan settings controls.

**Architecture:** Reuse the existing archive commands as the safe-delete boundary, keep selection repair in `CodexPage`, and expose actions through one accessible popover menu per project or conversation. Retain native select and number inputs, but wrap and style them consistently rather than replacing their keyboard behavior.

**Tech Stack:** React, TypeScript, Vitest/Testing Library, Tauri command client, CSS, Rust/rusqlite.

**Spec:** `docs/superpowers/specs/2026-11-05-codex-workspace-and-settings-polish-design.md`

## Global Constraints

- Safe deletion hides records through existing archive commands and does not erase snapshots, history, artifacts, or project directories.
- A project with a running turn cannot be deleted.
- Existing handoff, Codex execution, and scan-rule behavior must remain unchanged.
- Native controls retain keyboard and screen-reader behavior.

## Review Focus

- Deleting the selected project must select the next available project or render the first-project empty state.
- Deleting the selected conversation must select another visible conversation without leaving stale history.
- Cancelling a confirmation must not invoke an archive command.
- A running project must expose a disabled delete action and must not invoke an archive command.
- Menus and form controls must not clip, overlap, or create horizontal overflow at the supported desktop width.

---

### Task 1: Safe project and conversation deletion

**Files:**
- Modify: `apps/desktop/src/features/codex/CodexProjectSidebar.tsx`
- Modify: `apps/desktop/src/features/codex/CodexPage.tsx`
- Modify: `apps/desktop/src/features/codex/CodexPage.test.tsx`
- Modify: `apps/desktop/src/features/codex/codex.css`

**Interfaces:**
- Consumes: `QizhiCommands.archiveCodexProject(projectId)` and `archiveCodexConversation(conversationId)`.
- Produces: sidebar callbacks `onDeleteProject(project)` and `onDeleteConversation(conversation)` plus an accessible action menu.

- [ ] **Step 1: Write failing UI tests**

Add tests that open the relevant action menu, confirm safe deletion, assert the matching archive command receives the selected ID, and assert the next project/conversation becomes selected. Add cancellation and running-project cases.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/codex/CodexPage.test.tsx`

Expected: FAIL because delete menu items and callbacks do not exist.

- [ ] **Step 3: Implement safe deletion and selection repair**

Use the existing archive commands, an explicit confirmation dialog, and request identity checks so an async result cannot overwrite a newly selected project. Clear stale conversation history and pending handoffs when the selected item is removed.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 2: Codex destination and action-control visual polish

**Files:**
- Modify: `apps/desktop/src/features/codex/CodexDestinationDialog.tsx`
- Modify: `apps/desktop/src/features/codex/codex-dialog.css`
- Modify: `apps/desktop/src/features/codex/codex.css`
- Modify: `apps/desktop/src/features/codex/CodexDestinationDialog.test.tsx`

**Interfaces:**
- Consumes: existing native `select` state and dialog project/conversation loading.
- Produces: `.codex-select-control` wrappers and consistent icon buttons/popovers.

- [ ] **Step 1: Write failing structure/accessibility tests**

Assert both destination selects are inside the shared styled wrapper and action menus have explicit accessible names, menu roles, and menu items.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/codex/CodexDestinationDialog.test.tsx src/features/codex/CodexPage.test.tsx`

- [ ] **Step 3: Implement shared native-select styling and polished menus**

Add a visual chevron that does not intercept pointer events, consistent 40px control height, focus-visible rings, balanced padding, and a compact circular action trigger with an anchored menu.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 3: Scan settings layout and threshold control

**Files:**
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/settings.css`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`

**Interfaces:**
- Consumes: existing `directoryGroupThreshold` state and `saveScanRules` behavior.
- Produces: `.threshold-setting-row` and `.settings-block-actions` layout containers.

- [ ] **Step 1: Write failing layout-structure test**

Assert the threshold label/input use the dedicated row and that the save button is contained in the section action footer without changing its accessible name or submit behavior.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/settings/settings.test.tsx`

- [ ] **Step 3: Implement the settings structure and CSS**

Keep validation bounds 2–100, use a compact numeric control, give the display section and footer independent spacing, and prevent button overlap at narrower supported widths.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 4: Full verification and packaging

**Files:**
- Verify all modified files above.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a verified NSIS installer.

- [ ] **Step 1: Run quality gates**

Run `pnpm check`, `pnpm test -- --run`, `cargo fmt --check`, and `cargo test`.

- [ ] **Step 2: Perform rendered desktop QA**

Run the development UI, exercise project/conversation deletion, destination selects, action menus, and scan settings at the primary desktop viewport; verify no console errors, clipping, or overlap.

- [ ] **Step 3: Build and verify installer**

Run `pnpm --filter @qizhi/desktop tauri build`; record installer path, timestamp, size, and SHA-256.
