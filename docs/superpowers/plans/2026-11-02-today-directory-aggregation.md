# Today Directory Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Today file list with a lazily expanded directory-change tree whose threshold is configurable and whose directory selections can be summarized safely.

**Architecture:** Keep the NTFS index and `file_records` table as the source of truth. Build an in-memory, query-scoped workspace tree in Rust after scan-policy, time-range, category, and wildcard filtering; send only the requested tree level to React and resolve directory selections again on the backend. Preserve existing single-file operations while moving JEV discovery and large-summary batching behind the backend query boundary.

**Tech Stack:** Rust, Tauri 2 commands/channels, SQLite/rusqlite, React 19, TypeScript, Vitest/Testing Library, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-11-02-today-directory-aggregation-design.md`

## Global Constraints

- Directory grouping is presentation-only and must never trigger an NTFS rebuild when only its threshold changes.
- The threshold defaults to `5`, accepts `2–100`, and uses `>=` against direct matching files or direct matching child directories.
- Scan roots are never visible groups; nested roots assign each file to its longest matching root exactly once.
- The workspace tree contains only changed files that pass the current time range, scan policy, exclusions, enabled file categories, page category, and wildcard search.
- No Git, clone/download inference, application history, or LLM-generated directory labels.
- Search changes clear directory selections; a directory selected under a search includes only files matching that search.
- More than 20 files requires an explicit confirmation and hierarchical batches of at most 20 files; failed batches are never silently omitted.
- Existing file open, text-open, reveal, copy, delete, exclude-directory, RAGFlow upload, JEV status, Today/Recent tabs, and summary streaming must continue to work.

## Review Focus

- Nested allowed roots such as user profile plus Desktop must not duplicate files, counts, or summary inputs; Task 2 pins longest-root ownership.
- Windows paths that differ only by case or extended-path prefix must resolve to one node; Task 2 pins normalized case-insensitive keys.
- A search/category change during an expanded or selected tree must not keep hidden files selected; Task 5 pins query replacement and selection clearing.
- Files moved, deleted, or excluded after the tree is displayed must be rejected or omitted at backend selection resolution; Task 3 pins policy revalidation.
- A partial OpenAI batch failure must leave a visible failed summary instead of synthesizing an apparently complete answer; Task 6 pins failure propagation.

---

### Task 1: Persist and edit the directory grouping threshold

**Files:**
- Modify: `apps/desktop/src-tauri/src/scan/configuration.rs`
- Modify: `apps/desktop/src-tauri/src/commands/settings.rs`
- Modify: `apps/desktop/src/lib/contracts.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`
- Modify: `apps/desktop/src-tauri/tests/scan_configuration_test.rs`

**Interfaces:**
- Produces: `ScanRules.directory_group_threshold: u16` with Serde default `5`.
- Produces: `ScanRulesOutput.directory_group_threshold` / TypeScript `ScanRules.directoryGroupThreshold`.
- Produces: `indexer_fields_changed(previous: &ScanRules, next: &ScanRules) -> bool`, comparing only roots, exclusions, and file categories.

- [ ] **Step 1: Write failing Rust tests for legacy default, bounds, and indexer-relevant comparison**

Add tests proving a legacy JSON file loads threshold `5`, values `2` and `100` save, values outside that range are rejected by the settings validation helper, and a threshold-only change returns `false` from `indexer_fields_changed`.

- [ ] **Step 2: Run the focused Rust tests and verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test scan_configuration_test`

Expected: FAIL because the threshold field and comparison helper do not exist.

- [ ] **Step 3: Add the Rust field, validation, and conditional indexer configuration**

Add `default_directory_group_threshold() -> u16`, validate `2..=100`, return the field from list/save commands, and call `configure_local_indexer` only when `indexer_fields_changed` is true.

- [ ] **Step 4: Write failing SettingsPage tests**

Add assertions that the “今日页面展示” section loads `5`, saves a changed numeric value, and shows a validation error rather than calling `saveScanRules` for `1` or `101`.

- [ ] **Step 5: Run the focused frontend test and verify failure**

Run: `pnpm --filter @qizhi/desktop test -- src/features/settings/settings.test.tsx`

Expected: FAIL because the threshold control and API property do not exist.

- [ ] **Step 6: Implement the compact threshold setting**

Add a number input under “扫描与隐私 → 今日页面展示”, include `directoryGroupThreshold` in `saveScanRules`, preserve existing success/error styling, and update unavailable command defaults.

- [ ] **Step 7: Run focused tests and commit**

Run both focused commands from Steps 2 and 5; expect PASS.

Commit: `feat: add today directory grouping threshold`

### Task 2: Build a pure Rust directory-change tree

**Files:**
- Create: `apps/desktop/src-tauri/src/today_workspace.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/tests/today_workspace_test.rs`

**Interfaces:**
- Consumes: `FileRecord`, allowed roots, threshold, category/search predicates, and optional persisted value state.
- Produces: `WorkspaceTree::build(input: WorkspaceBuildInput) -> Result<WorkspaceTree, WorkspaceBuildError>`.
- Produces: `WorkspaceTree::page(parent_id: Option<&str>, cursor: usize, limit: usize, sort: WorkspaceSort) -> WorkspacePage`.
- Produces: `WorkspaceTree::resolve(file_ids: &[i64], directory_ids: &[String]) -> Vec<i64>` with de-duplication.

- [ ] **Step 1: Write failing tests for direct threshold and contextual parent behavior**

Cover 4 versus 5 direct files, 5 direct changed child directories, `D:\工作\项目A\src` rendering `项目A` at root and `src` after expansion, and two deep groups sharing one visible parent.

- [ ] **Step 2: Write failing tests for ownership and path normalization**

Cover overlapping roots (`C:\Users\u` plus Desktop), case-only path differences, `\\?\` display paths, one-file-one-branch, and no visible scan-root node.

- [ ] **Step 3: Write failing tests for filtering, search, sorting, and paging**

Prove filtering happens before counts; wildcard search prunes branches but keeps directory-group identity; directory-first ordering works for name/time sorts; page size `200` reports a continuation cursor.

- [ ] **Step 4: Run the new integration test and verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test today_workspace_test`

Expected: FAIL because `today_workspace` does not exist.

- [ ] **Step 5: Implement normalized tree construction and entry statistics**

Define serializable `WorkspaceEntry`, `WorkspacePage`, `WorkspaceValueSummary`, `WorkspaceSort`, internal directory/file nodes, longest-root assignment, deepest-group discovery, direct-parent context nodes, and stable hashed entry IDs. Use case-insensitive normalized path keys while retaining display paths.

- [ ] **Step 6: Implement page and selection resolution**

Return only direct display children, preserve child existence/count metadata, page at 200, and resolve directory descendants plus explicit files into sorted unique IDs.

- [ ] **Step 7: Run the focused Rust test and commit**

Expected: all `today_workspace_test` cases PASS.

Commit: `feat: build directory change workspace tree`

### Task 3: Expose query-scoped workspace commands safely

**Files:**
- Modify: `apps/desktop/src-tauri/src/app_state.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/commands/today.rs`
- Modify: `apps/desktop/src-tauri/src/ntfs/ipc.rs`
- Modify: `apps/desktop/src-tauri/src/ntfs/control.rs`
- Modify: `apps/desktop/src-tauri/tests/ntfs_ipc_policy_test.rs`
- Create: `apps/desktop/src-tauri/tests/today_workspace_command_test.rs`

**Interfaces:**
- Produces: `WorkspaceQueryStore` in `AppState`, retaining at most 8 queries for 10 minutes.
- Produces Tauri commands `query_today_workspace(input) -> WorkspacePage`, `expand_today_workspace(query_id, directory_id, cursor) -> WorkspacePage`, `resolve_today_workspace_selection(input) -> WorkspaceSelectionOutput`, and `open_today_workspace_directory(query_id, directory_id) -> Result<(), String>`.
- Produces: `WorkspaceSelectionOutput { file_ids, file_count, batch_count }` after current policy revalidation.

- [ ] **Step 1: Write failing command tests**

Use a temporary database and scan-rule store to prove root query creation, child expansion, expired/unknown query rejection, current-policy revalidation after an exclusion change, and parent/child/file mixed selection de-duplication.

- [ ] **Step 2: Add the Review Focus moved/deleted/excluded test**

Build a query, then exclude or delete one member before resolution; assert the file is not returned and the count reflects the actual safe set.

- [ ] **Step 3: Run the command test and verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test today_workspace_command_test`

Expected: FAIL because query storage and commands do not exist.

- [ ] **Step 4: Implement query storage and Tauri commands**

Construct the tree from `FileRepository::list_for_local_day`, current `ScanPolicy`, category/search/sort and `directory_group_threshold`; store immutable query inputs/tree by random query ID; reapply rules and file existence checks when resolving or opening.

- [ ] **Step 5: Remove the silent Recent 5000-item truncation**

Use the untruncated range response path for Recent records (the existing `ListToday` range fields accept arbitrary bounds) and add a control-plane test proving a range larger than 5000 is not silently truncated. If the response exceeds IPC limits, return an explicit incomplete/error state rather than partial statistics.

- [ ] **Step 6: Register commands, run focused Rust tests, and commit**

Run the Task 3 tests plus `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test ntfs_ipc_policy_test`; expect PASS.

Commit: `feat: expose today workspace tree commands`

### Task 4: Move folded-file JEV discovery behind the workspace query

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/value.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/value_assessment_repository.rs`
- Modify: `apps/desktop/src-tauri/src/today_workspace.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tests/jev_value_test.rs`
- Modify: `apps/desktop/src-tauri/tests/today_workspace_test.rs`

**Interfaces:**
- Produces: `evaluate_workspace_query(query_id: String) -> WorkspaceEvaluationOutput` for all pending document files in the query, internally processed in bounded chunks.
- Produces: `ValueAssessmentRepository::list_current_for_files(files: &[FileRecord]) -> HashMap<FileAssessmentKey, FileValueAssessment>`.
- Consumes: workspace entry value summaries when serializing pages.

- [ ] **Step 1: Write failing tests for folded document discovery and aggregate values**

Prove a document not present on the root page still enters the evaluation candidate set, source-code-only files do not, saved results produce correct directory counts, and an error result remains retryable.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test jev_value_test --test today_workspace_test`

- [ ] **Step 3: Extract reusable file evaluation and add query-level evaluation**

Keep `evaluate_today_files` for compatibility, but have both commands call one bounded evaluator. Query-level evaluation resolves document IDs from the backend tree, processes all candidates in chunks of at most 200 per loop, and returns counts rather than every result to React.

- [ ] **Step 4: Load persisted results while building workspace statistics**

Use the repository batch method to avoid one database query per file and refresh tree/page statistics after evaluation completes.

- [ ] **Step 5: Run focused tests and commit**

Expected: PASS.

Commit: `feat: evaluate folded workspace documents`

### Task 5: Replace the flat Today table with the expandable directory tree

**Files:**
- Modify: `apps/desktop/src/lib/contracts.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Create: `apps/desktop/src/features/today/WorkspaceTreeTable.tsx`
- Create: `apps/desktop/src/features/today/workspaceSelection.ts`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes: Task 3 query/expand/resolve commands and Task 4 evaluation command.
- Produces: `WorkspaceTreeTable` with lazy row expansion, directory/file checkboxes, half-selected state, paging, retry, and existing file action callbacks.
- Produces: `WorkspaceSelectionState` containing explicit file IDs and directory IDs for exactly one `queryId`.

- [ ] **Step 1: Add failing contract and root rendering tests**

Mock a workspace root with a directory and loose file; assert compact aligned rows, directory statistics, folder/file icons, no legacy full-file rendering, and empty results remain a normal empty state.

- [ ] **Step 2: Add failing expand, retry, paging, and operation tests**

Assert expansion calls the child command once, shows an inline loading state, renders nested indentation, retries only the failed row, loads a continuation page, opens directories, and retains all existing single-file actions.

- [ ] **Step 3: Add failing selection and query replacement tests**

Assert directory full/partial/empty states, parent/child de-duplication via backend preflight, category/search change clears directory selections with a toast, hidden file selections are removed, and Today/Recent create separate queries.

- [ ] **Step 4: Run the Today test and verify failure**

Run: `pnpm --filter @qizhi/desktop test -- src/features/today/today.test.tsx`

- [ ] **Step 5: Implement TypeScript contracts and command adapters**

Add discriminated directory/file entry types, page/query inputs, selection output, evaluation output, and methods matching Task 3/4 command names.

- [ ] **Step 6: Implement `WorkspaceTreeTable` and integrate TodayPage**

Use `aria-expanded`, `aria-level`, stable keyed rows and an indeterminate checkbox ref. Keep the existing compact table header and context menu; directory rows show aggregate value text rather than a clickable JEV pill.

- [ ] **Step 7: Add polished tree styles and responsive constraints**

Keep row text on one line, ellipsize long paths/names, constrain indentation, prevent horizontal page scrolling, and keep the table body vertically scrollable.

- [ ] **Step 8: Trigger backend JEV evaluation and reload page statistics**

After a successful workspace query, start query-level evaluation without blocking the list; when it finishes, refresh the current tree query/page while preserving expanded paths where still valid.

- [ ] **Step 9: Run focused frontend tests and commit**

Expected: PASS.

Commit: `feat: show today files as a directory change tree`

### Task 6: Support confirmed hierarchical summaries for directory selections

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/summary.rs`
- Modify: `apps/desktop/src-tauri/src/openai/client.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tests/summary_command_test.rs`
- Modify: `apps/desktop/src-tauri/tests/openai_summary_test.rs`
- Modify: `apps/desktop/src/lib/contracts.ts`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/SummaryResultDialog.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Produces: `prepare_work_summary(input: WorkSummarySelectionInput) -> WorkSummaryPreparation { file_count, batch_count, requires_confirmation }`.
- Extends: `GenerateWorkSummaryInput` with `query_id`, `directory_ids`, explicit `file_ids`, and `confirmed_multi_batch`.
- Extends: `WorkSummaryStreamEvent` with `batchProgress { current, total, phase }`.
- Produces: `plan_summary_batches(file_ids: &[i64]) -> Vec<Vec<i64>>`, preserving at most 20 per batch after de-duplication.

- [ ] **Step 1: Write failing batch planning and preflight tests**

Assert 20 files make one batch without confirmation; 21 make two and require confirmation; overlapping directory/file selections de-duplicate; zero safe files fails; current policy is reapplied.

- [ ] **Step 2: Write the partial-batch failure test**

With a mock OpenAI endpoint, make batch 2 fail and assert no synthesis request occurs, the command returns failure, and the stream reports the failed batch rather than `completed`.

- [ ] **Step 3: Run focused Rust tests and verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test summary_command_test --test openai_summary_test`

- [ ] **Step 4: Implement preflight, batch summaries, and final synthesis**

Resolve selections through the query store; enforce confirmation before multi-batch execution; reuse current extraction/privacy/40 MB per-batch limits; summarize each batch with the chosen template, then send only the batch summaries plus the same template intent for final synthesis.

- [ ] **Step 5: Add failing frontend confirmation and directory-summary tests**

Assert “总结此目录” opens preflight, 21 files show count/batches and make no generation call until confirmed, cancellation makes no model call, and the summary dialog shows batch progress then streamed Markdown.

- [ ] **Step 6: Implement summary selection UI and progress**

Use the existing split-button template choice. Directory action preselects that directory; top summary uses current mixed selection. Call preflight first, use a native styled confirmation dialog in the app (not a PowerShell/console window), then immediately open `SummaryResultDialog` before generation.

- [ ] **Step 7: Run focused Rust/frontend tests and commit**

Expected: PASS.

Commit: `feat: summarize directory selections in batches`

### Task 7: Regression, accessibility, and end-to-end verification

**Files:**
- Modify: `apps/desktop/e2e/today.spec.ts`
- Modify as required by failures: files touched in Tasks 1–6 only

**Interfaces:**
- Consumes all prior task outputs.
- Produces no new product interface.

- [ ] **Step 1: Add an end-to-end directory scenario**

Cover a mocked Today response with `项目A → src`, expansion, directory selection, search clearing the selection, and a confirmed two-batch summary opening immediately.

- [ ] **Step 2: Run all frontend tests and static checks**

Run: `pnpm test`

Run: `pnpm check`

Expected: all tests, TypeScript, ESLint, and Prettier PASS.

- [ ] **Step 3: Run all Rust tests and formatting checks**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Run: `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`

Expected: PASS.

- [ ] **Step 4: Run the production desktop build**

Run: `pnpm --filter @qizhi/desktop build`

Expected: TypeScript and Vite production build PASS.

- [ ] **Step 5: Run the focused browser end-to-end test**

Run: `pnpm --filter @qizhi/desktop e2e -- today.spec.ts`

Expected: PASS without horizontal overflow, clipped context menus, or page-level scrolling regressions.

- [ ] **Step 6: Review logs and perform a Windows smoke test**

Verify Today and Recent empty states, a 4-file directory, a 5-file directory, an expanded large directory, threshold change without index rebuild, file actions, JEV refresh, and summary confirmation/progress.

- [ ] **Step 7: Commit final regression fixes**

Commit: `test: verify today directory aggregation workflow`
