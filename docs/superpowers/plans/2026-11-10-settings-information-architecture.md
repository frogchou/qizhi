# Settings Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the growing single-column settings page with a prototype-aligned category navigation that preserves every existing setting and unsaved input.

**Architecture:** Keep `SettingsPage` as the owner of all loaded settings and draft state. Add a local active-category state and render all five category panels persistently, using the `hidden` attribute so switching visibility never unmounts form components. Use a two-column settings workspace on desktop and a horizontally scrollable category bar at narrow widths.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-11-10-settings-information-architecture-design.md`

## Global Constraints

- Do not change Tauri commands, persisted settings formats, credential handling, or backend behavior.
- Display only implemented categories: 扫描与隐私、连接服务、价值评估、今日总结、Codex 工作.
- Default to 扫描与隐私 and keep inactive panels mounted so unsaved drafts survive category switches.
- At narrow widths, move category navigation above content without page-level horizontal overflow.
- Preserve existing labels, status messages, validation, save actions, and connection tests.

## Review Focus

- A user types an unsaved API URL, switches categories, and returns: the draft must remain unchanged; covered in Task 1.
- Hidden service forms must not remain visible or keyboard-relevant; covered in Task 1.
- Async settings loads completing after a category switch must populate their original panel without changing the active category; covered in Task 1.
- A narrow window with five category labels must not create page-level horizontal overflow; covered in Task 2.
- Existing save/test actions must still call the same command payloads after navigation is introduced; covered in Task 3.

---

### Task 1: Category Navigation and Persistent Panels

**Files:**
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`

**Interfaces:**
- Consumes: existing `SettingsPage({ commands }: SettingsPageProps)` and child sections.
- Produces: local `SettingsCategory` union, category navigation controls, and persistently mounted category panels identified by stable IDs.

- [x] **Step 1: Write failing category-navigation tests**

Add tests named `shows one settings category at a time and marks the active navigation item`, `preserves unsaved drafts while switching settings categories`, and `does not change category when asynchronous settings finish loading`. Assert the default panel, all five navigation labels, `aria-current`, hidden inactive panels, and preserved OpenAI draft value.

- [x] **Step 2: Run the settings test and verify RED**

Run: `pnpm test --run src/features/settings/settings.test.tsx`

Expected: FAIL because the category navigation and hidden panels do not exist.

- [x] **Step 3: Implement the navigation and panel structure**

In `SettingsPage.tsx`, add `type SettingsCategory = "privacy" | "services" | "value" | "summary" | "codex"`, an ordered category descriptor list, `activeCategory` state defaulting to `privacy`, a `nav[aria-label="设置分类"]`, and five stable panels. Move only JSX ownership: split the JEV policy from its service credential card, wrap `SummarySettingsSection` and `CodexSettingsSection` in their category panels, and keep all panels rendered with `hidden={activeCategory !== id}`.

- [x] **Step 4: Run the settings test and verify GREEN**

Run: `pnpm test --run src/features/settings/settings.test.tsx`

Expected: all settings tests PASS.

### Task 2: Prototype-Aligned Layout and Responsive Behavior

**Files:**
- Modify: `apps/desktop/src/App.css`
- Modify: `apps/desktop/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `.settings-workspace`, `.settings-category-nav`, `.settings-category-button`, and `.settings-category-panel` emitted by Task 1.
- Produces: fixed desktop subnavigation, independently scrolling content, compact active styling, and narrow-width horizontal navigation.

- [x] **Step 1: Write failing Playwright layout checks**

Create settings e2e coverage for desktop category switching and a narrow viewport. Assert the active panel changes, the page has no horizontal overflow, and navigation remains usable without overlapping content.

- [x] **Step 2: Run settings e2e and verify RED**

Run: `pnpm exec playwright test e2e/settings.spec.ts`

Expected: FAIL because the new layout selectors and responsive rules are absent.

- [x] **Step 3: Implement desktop and narrow-window CSS**

Add scoped settings workspace styles in `App.css`: a 176px navigation column, sticky category navigation, bounded content panel, compact button states, and consistent section spacing. At the existing desktop-narrow breakpoint, switch to one column, render navigation as a horizontal overflow strip, and guarantee `min-width: 0` on the content column.

- [x] **Step 4: Run settings e2e and verify GREEN**

Run: `pnpm exec playwright test e2e/settings.spec.ts`

Expected: all settings layout scenarios PASS.

### Task 3: Preserve Existing Settings Behavior and Documentation

**Files:**
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`
- Modify: `apps/desktop/src/features/settings/README.md`
- Modify: `apps/desktop/src/features/settings/README_EN.md`

**Interfaces:**
- Consumes: category buttons and panels from Task 1.
- Produces: regression coverage that enters the correct category before exercising existing actions, plus module documentation for the new information architecture.

- [x] **Step 1: Update behavior tests to navigate explicitly**

Before tests interact with OpenAI, JEV policy, RAGFlow, summary, or Codex settings, click the appropriate category. Keep the existing assertions on command payloads, masking, validation, and notices unchanged.

- [x] **Step 2: Run settings tests**

Run: `pnpm test --run src/features/settings/settings.test.tsx src/features/settings/SummarySettingsSection.test.tsx`

Expected: all tests PASS and original command assertions remain intact.

- [x] **Step 3: Update module documentation**

Document the five categories, persistent draft-state behavior, and responsive navigation in both settings README files.

- [x] **Step 4: Run complete frontend verification**

Run: `pnpm test --run`

Expected: zero failed tests.

Run: `pnpm check`

Expected: TypeScript, ESLint, and Prettier all exit successfully.

Run: `pnpm build`

Expected: production build exits successfully.

Run: `pnpm e2e`

Expected: all Playwright scenarios pass; if the known Vite child-process cleanup issue recurs after all scenarios report `ok`, record it separately rather than treating a passed assertion as a UI failure.
