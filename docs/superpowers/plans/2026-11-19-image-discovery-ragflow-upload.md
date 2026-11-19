# 图片发现与 RAGFlow 上传实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户按需在今日 / 过去工作区发现常见图片，并通过现有 RAGFlow 上传流程将图片加入知识库，同时保持图片默认关闭且不参与 JEV 和今日总结。

**Architecture:** 在现有 `FileCategory` / `WorkspaceCategory` 中增加 `images`，由同一套扫描规则控制发现、查询和上传校验。前端设置页用独立图片区控制该类别，今日页增加图片筛选和可见上传入口；总结与 JEV 继续用文档专用过滤器，避免图片进入文本分析。

**Tech Stack:** Rust, Serde, Tauri 2, React 19, TypeScript, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-11-19-image-discovery-ragflow-upload-design.md`

## Global Constraints

- 图片搜索默认关闭；`default_file_categories()` 必须继续只返回 `Documents + SourceCode`。
- 支持格式固定为 JPG/JPEG、PNG、WebP、TIF/TIFF、GIF。
- 图片不参与 JEV 自动或手动评估，也不参与今日总结文本提取。
- 图片必须继续遵守允许扫描范围、排除目录和上传前存在性检查。
- 复用现有 RAGFlow multipart 上传、知识库选择、目录和解析开关，不新增 RAGFlow 接口。
- 旧扫描设置无需迁移；没有 `images` 即表示关闭。

## Review Focus

- 旧配置只有 `documents` / `sourceCode` 时，升级后不得出现图片。
- 选择 `images` 时只显示受支持图片，`documents` 与 `sourceCode` 不得混入图片。
- 图片搜索关闭后，旧工作区选择令牌不得绕过当前规则继续上传图片。
- 图片不得触发 JEV 请求或因总结文本提取失败而中断整个总结流程。
- 目录聚合中的图片必须稳定显示为“不评估”，行内上传与右键上传必须打开同一个对话框。

---

### Task 1: 后端图片类别与工作区筛选

**Files:**

- Modify: `apps/desktop/src-tauri/src/scan/file_filter.rs`
- Modify: `apps/desktop/src-tauri/src/today_workspace.rs`
- Test: `apps/desktop/src-tauri/src/scan/file_filter.rs`
- Test: `apps/desktop/src-tauri/src/today_workspace.rs`

**Interfaces:**

- Produces: `FileCategory::Images`, `WorkspaceCategory::Images`
- Produces: `FileTypeFilter::allows(&Path) -> bool` supporting the fixed image extension set
- Preserves: `default_file_categories() -> Vec<FileCategory>` returning only documents and source code

- [ ] **Step 1: Add failing file-filter tests**

Add tests asserting that an images-only filter accepts `photo.jpg`, `scan.JPEG`, `diagram.png`, `board.webp`, `page.tif`, `page.tiff`, and `animation.gif`, while rejecting `report.docx`, `main.rs`, `photo.bmp`, `vector.svg`, and `raw.cr2`. Add an assertion that `FileTypeFilter::default()` still rejects images.

- [ ] **Step 2: Run the file-filter tests and verify RED**

Run: `cargo test scan::file_filter::tests --lib`

Expected: FAIL because `FileCategory::Images` does not exist.

- [ ] **Step 3: Implement `FileCategory::Images` and `IMAGE_EXTENSIONS`**

Extend `FileTypeFilter::allows` to recognize the fixed image formats only when `Images` is selected. Do not add Images to `default_file_categories()`.

- [ ] **Step 4: Run the file-filter tests and verify GREEN**

Run: `cargo test scan::file_filter::tests --lib`

Expected: PASS.

- [ ] **Step 5: Add failing workspace-category tests**

Add a focused `today_workspace` test that builds a tree from one DOCX, one Rust file, one PNG, and one BMP. Assert that `WorkspaceCategory::Images` exposes only PNG and that `WorkspaceCategory::All` exposes DOCX, Rust, and PNG but not BMP.

- [ ] **Step 6: Run the workspace tests and verify RED**

Run: `cargo test today_workspace::tests --lib`

Expected: FAIL because `WorkspaceCategory::Images` and the image branch do not exist.

- [ ] **Step 7: Implement workspace image filtering**

Add `WorkspaceCategory::Images`; make `All` use documents, source code, and images. Keep query results bounded by the already-saved scan-rule filter in `commands/today.rs`.

- [ ] **Step 8: Run the workspace tests and verify GREEN**

Run: `cargo test today_workspace::tests --lib`

Expected: PASS.

### Task 2: 图片上传安全与总结隔离

**Files:**

- Modify: `apps/desktop/src-tauri/src/commands/knowledge.rs`
- Modify: `apps/desktop/src-tauri/src/commands/summary.rs`
- Test: `apps/desktop/src-tauri/src/commands/knowledge.rs`
- Test: `apps/desktop/src-tauri/src/commands/summary.rs`

**Interfaces:**

- Consumes: `FileCategory::Images`
- Produces: `is_summary_candidate(path: &Path) -> bool` as the single summary eligibility rule
- Preserves: `ensure_upload_candidate(...) -> Result<PathBuf, String>` current range and exclusion validation

- [ ] **Step 1: Add an image upload-candidate regression test**

Create a temporary PNG under an allowed temporary root. Assert that `ensure_upload_candidate` succeeds with an images-only filter and fails with the default filter. This pins the existing generic upload path after Task 1; it is expected to pass without image-specific upload production code.

- [ ] **Step 2: Run the knowledge command regression test**

Run: `cargo test commands::knowledge::tests --lib`

Expected: PASS, proving the generic RAGFlow upload candidate validation already accepts enabled images and rejects disabled images.

- [ ] **Step 3: Keep upload validation generic**

Do not add image-specific upload code. Confirm the same RAGFlow upload command accepts the candidate only when images are enabled.

- [ ] **Step 4: Add failing summary eligibility tests**

Add tests asserting `is_summary_candidate("report.docx") == true` and `is_summary_candidate("photo.png") == false`. Add the pure helper to both query-based and direct summary selection paths so a directory containing documents and images resolves only the documents; an image-only selection produces `今日总结仅支持文档与文本。`.

- [ ] **Step 5: Run summary tests and verify RED**

Run: `cargo test commands::summary::tests --lib`

Expected: FAIL because the summary-specific filter and error do not exist.

- [ ] **Step 6: Implement summary-only document filtering**

Filter resolved query IDs and direct IDs through `FileTypeFilter::new(vec![FileCategory::Documents])` before preparation and loading. Keep the existing scan policy check in addition to the document check.

- [ ] **Step 7: Run command tests and verify GREEN**

Run: `cargo test commands::knowledge::tests --lib`

Run: `cargo test commands::summary::tests --lib`

Expected: PASS.

### Task 3: 设置页图片搜索开关与类型契约

**Files:**

- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/App.css`
- Test: `apps/desktop/src/features/settings/settings.test.tsx`

**Interfaces:**

- Produces: TypeScript `FileCategory = "documents" | "sourceCode" | "images"`
- Produces: TypeScript `WorkspaceCategory = "all" | "documents" | "sourceCode" | "images"`
- Persists: `ScanRules.fileCategories` through the existing `saveScanRules` command

- [ ] **Step 1: Add failing settings tests**

Add one test asserting that a loaded legacy rule without `images` renders `在今日和过去中发现图片` unchecked. Add another test that enables the switch, saves, and expects `fileCategories: ["documents", "sourceCode", "images"]`; disable it again and expect images to be removed.

- [ ] **Step 2: Run settings tests and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/settings/settings.test.tsx`

Expected: FAIL because the image search control and TypeScript category do not exist.

- [ ] **Step 3: Extend TypeScript contracts and fallback defaults**

Add `images` to both category unions. Keep `browserFallbackCommands.listScanRules()` at `documents + sourceCode` so browser/demo and legacy behavior stay opt-in.

- [ ] **Step 4: Implement the independent 图片搜索 settings section**

Render a dedicated card below file types with the switch, supported-format copy, and the JEV/RAGFlow behavior explanation. Bind it to `toggleFileCategory("images", checked)` and extend the save-success copy with `图片搜索已开启/关闭`.

- [ ] **Step 5: Add focused responsive styling**

Add `image-search-settings` styles in `App.css` using the existing settings card language. Keep the label usable at narrow widths and do not move the main save action.

- [ ] **Step 6: Run settings tests and verify GREEN**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/settings/settings.test.tsx`

Expected: PASS.

### Task 4: 今日图片筛选、图标和上传入口

**Files:**

- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/WorkspaceTreeTable.tsx`
- Modify: `apps/desktop/src/components/FileTypeIcon.tsx`
- Modify: `apps/desktop/src/App.css`
- Test: `apps/desktop/src/features/today/today.test.tsx`
- Test: `apps/desktop/src/components/FileTypeIcon.test.tsx`

**Interfaces:**

- Consumes: TypeScript `WorkspaceCategory` including `images`
- Produces: `fileCategory(path)` recognizing the fixed image set
- Produces: `WorkspaceTreeTable.onUploadFile(id: number)` for a visible image-row upload action
- Produces: `FileVisualType` including `image`

- [ ] **Step 1: Add failing Today tests**

Add a snapshot containing DOCX, Rust, PNG, WebP, and BMP files. Assert that selecting `图片` shows PNG/WebP only, sends `category: "images"` to `queryTodayWorkspace`, labels image rows `图片 · 不评估`, and never includes their IDs in `evaluateTodayFiles`.

- [ ] **Step 2: Add a failing image upload-entry test**

For a query-backed image row, click its visible `上传` action and assert that the existing `上传到知识库` dialog opens. Also assert the existing context-menu upload still works.

- [ ] **Step 3: Run Today tests and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/today/today.test.tsx`

Expected: FAIL because the image option, labels, and row upload callback do not exist.

- [ ] **Step 4: Add failing file icon tests**

Assert `fileVisualType` returns `image` for PNG, JPG, WebP, TIF, TIFF, and GIF, and renders an accessible `图片文件` icon.

- [ ] **Step 5: Run icon tests and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- --run src/components/FileTypeIcon.test.tsx`

Expected: FAIL because `image` is not a visual type.

- [ ] **Step 6: Implement Today image behavior**

Use `WorkspaceCategory` for state and query construction, add the dropdown option, extend the fallback classifier, and add a specific image empty-state hint when no image is available. Pass `openUploadDialog` to `WorkspaceTreeTable`; render `上传` next to `打开` only for image file rows. Keep document JEV behavior unchanged.

- [ ] **Step 7: Implement the image file icon and action styling**

Add an `image` icon marker/color and compact dual-action layout that does not widen or overflow the table.

- [ ] **Step 8: Run Today and icon tests and verify GREEN**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/today/today.test.tsx src/components/FileTypeIcon.test.tsx`

Expected: PASS.

### Task 5: 文档与全量验证

**Files:**

- Modify: `apps/desktop/src/features/today/README.md`
- Modify: `apps/desktop/src/features/today/README_EN.md`
- Modify: `apps/desktop/src/features/settings/README.md`
- Modify: `apps/desktop/src/features/settings/README_EN.md`

**Interfaces:**

- Documents: image discovery opt-in, supported formats, no JEV/summary processing, RAGFlow parser ownership

- [ ] **Step 1: Update module documentation**

Document the image search switch, supported formats, Today filter, upload behavior, and why OCR/VLM remains configured in RAGFlow.

- [ ] **Step 2: Run formatting and static checks**

Run: `Push-Location apps/desktop/src-tauri; cargo fmt --check; Pop-Location`

Run: `pnpm check`

Expected: PASS.

- [ ] **Step 3: Run full automated test suites**

Run: `Push-Location apps/desktop/src-tauri; cargo test; Pop-Location`

Run: `pnpm test -- --run`

Expected: all runnable tests PASS; environment-specific ignored tests remain explicitly reported.

- [ ] **Step 4: Build the desktop application**

Run: `pnpm --filter @qizhi/desktop build`

Expected: TypeScript and Vite production build PASS.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check` and inspect all changed files against the spec. Confirm no credentials, generated build output, or unrelated changes were added.
