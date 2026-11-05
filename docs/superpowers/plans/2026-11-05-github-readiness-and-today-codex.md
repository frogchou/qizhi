# GitHub Readiness and Today-to-Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Today-to-Codex handoff, expose batch sending at the page top, and prepare bilingual public documentation.

**Architecture:** Keep the TypeScript command contract camelCase and correct deserialization at the Rust/Tauri boundary. Reuse the existing workspace selection and destination dialog, changing only the button placement and contract coverage. Document the repository from the root down to its principal frontend and Rust modules.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2, Rust, Serde, Markdown

**Spec:** `docs/superpowers/specs/2026-11-05-github-readiness-and-today-codex-design.md`

## Global Constraints

- Preserve the dirty `main` worktree and all existing user changes.
- Do not push, rewrite history, or add a license without explicit authorization.
- Never place service keys or local credentials in source or documentation.

## Review Focus

- Nested enum fields must deserialize from camelCase, not only enum variant names.
- Multi-file and directory selections must remain frozen while the destination dialog is open.
- The top action must be disabled for an empty selection and enabled for multiple selected items.
- Public docs must distinguish current capabilities from planned work.
- Build output, local databases, logs, credential exports, and pnpm cache must stay untracked.

---

### Task 1: Handoff contract regression

**Files:**

- Modify: `apps/desktop/src-tauri/tests/codex_handoff_commands_test.rs`
- Modify: `apps/desktop/src-tauri/src/commands/codex_handoff.rs`

**Interfaces:**

- Consumes: frontend JSON `{ source: { kind, queryId, fileIds, directoryIds } }`
- Produces: `PrepareCodexHandoffInput`

- [x] Add a JSON deserialization test for Today and Recent camelCase fields.
- [x] Run the test and confirm the missing `query_id` contract failure.
- [x] Apply the minimal Serde field-renaming fix.
- [x] Run the focused Rust test and confirm it passes.

### Task 2: Top-level batch action

**Files:**

- Modify: `apps/desktop/src/features/today/today.test.tsx`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**

- Consumes: `selectedFileIds`, `selectedDirectoryIds`, active workspace `queryId`
- Produces: one `CodexHandoffSourceInput` for all selected items

- [x] Add a test selecting multiple files and asserting the action lives in the page header.
- [x] Run the test and confirm it fails for the current toolbar placement.
- [x] Move the existing action to the header without duplicating handoff logic.
- [x] Run the focused frontend test and confirm it passes.

### Task 3: Public repository documentation

**Files:**

- Modify: `README.md`, `.gitignore`, `apps/desktop/README.md`
- Create: `README_EN.md`, `apps/desktop/README_EN.md`
- Create: module README files under `apps/desktop/src/features` and `apps/desktop/src-tauri/src`

**Interfaces:**

- Produces: bilingual navigation, setup instructions, architecture map, module ownership notes

- [x] Audit the current module tree, commands, and ignored local outputs.
- [x] Write Chinese and English root documentation with matching structure.
- [x] Add concise bilingual module descriptions for the principal frontend and Rust modules.
- [x] Scan tracked and untracked source paths for credential patterns without printing values.

### Task 4: Verification

**Files:**

- Verify all modified sources and docs.

- [x] Run formatter and static checks.
- [x] Run the complete frontend test suite.
- [x] Run Rust formatting and the complete Rust test suite.
- [x] Build the desktop frontend.
- [x] Review `git diff` and confirm no secrets or generated caches are included.
