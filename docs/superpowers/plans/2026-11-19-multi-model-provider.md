# Multi-Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add retained configurations for common OpenAI-compatible model providers with exactly one active provider, migrate the existing OpenAI summary configuration without disruption, and replace the sidebar tagline with the application version.

**Architecture:** A new `model_provider_settings` repository owns provider endpoint, model, credential reference, capability and activation state. A provider service merges saved rows with built-in presets, stores secrets in Windows Credential Manager, and exposes dedicated Tauri commands. The existing summary client becomes provider-aware while reusing the current Responses parsing and local text fallback paths.

**Tech Stack:** Rust, rusqlite, Tauri 2, reqwest, Windows Credential Manager, React 19, TypeScript, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-model-provider-design.md`

## Global Constraints

- Preserve the current OpenAI endpoint, credential reference and summary model through migration.
- At most one provider may have `is_active = 1`.
- Saving or testing a provider must not switch the active provider.
- JEV, RAGFlow and Codex CLI configuration behavior must not change.
- Ollama accepts an empty API key; all other providers require a stored or newly supplied key.
- Existing summary file selection, batching, prompt templates, rendering, save and RAGFlow upload behavior remain unchanged.
- Do not overwrite unrelated uncommitted image-discovery work already present in the worktree.

## Review Focus

- A legacy OpenAI endpoint containing only a host must still resolve through `/v1` after migration; pin this in Task 1.
- Saving an edited provider with a blank API-key field must retain an existing secret rather than erase it; pin this in Task 2.
- A failed test request must not save or activate the edited provider; pin this in Task 3.
- A Chat-only provider must never receive raw file bytes through Responses; pin this in Task 4.
- Settings reload must show the one persisted active provider and the retained settings for every configured provider; pin this in Task 5.

---

### Task 1: Provider Persistence and Legacy Migration

**Files:**
- Create: `apps/desktop/src-tauri/migrations/0015_model_providers.sql`
- Create: `apps/desktop/src-tauri/src/database/repositories/model_provider_repository.rs`
- Modify: `apps/desktop/src-tauri/src/database/migrations.rs`
- Modify: `apps/desktop/src-tauri/src/database/repositories/mod.rs`
- Modify: `apps/desktop/src-tauri/src/database/mod.rs`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`
- Test: `apps/desktop/src-tauri/tests/model_provider_repository_test.rs`

**Interfaces:**
- Produces: `ModelProviderConfig`, `ModelProviderRepository::{list, find, active, save, activate}`.
- Produces: migration 15 seeded from `app_config.service='openai'` and `openai_summary_settings.model`.

- [ ] **Step 1: Write failing repository and migration tests**

Add tests asserting legacy OpenAI configuration becomes the only active provider, keeps its credential reference and model, host-only endpoints normalize to `/v1`, saving another provider does not activate it, and activating it clears the previous active row.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test --test model_provider_repository_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: FAIL because migration 15 and the repository do not exist.

- [ ] **Step 3: Add migration 15 and `ModelProviderRepository`**

Implement the schema, unique partial active index, legacy seed query and transactional activation. Add the repository accessor to `Database`.

- [ ] **Step 4: Run the focused Rust test and verify GREEN**

Run: `cargo test --test model_provider_repository_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

### Task 2: Provider Presets, Validation and Secret Retention

**Files:**
- Create: `apps/desktop/src-tauri/src/config/model_provider.rs`
- Modify: `apps/desktop/src-tauri/src/config/mod.rs`
- Test: `apps/desktop/src-tauri/tests/model_provider_service_test.rs`

**Interfaces:**
- Consumes: `ModelProviderRepository` from Task 1 and `SecretStore`.
- Produces: `ModelProviderId`, `ModelProviderPreset`, `ModelProviderService<S>`.
- Produces: `list()`, `save(input)`, `activate(id)`, `active()` and `resolve_api_key(config)`.

- [ ] **Step 1: Write failing preset and service tests**

Assert the eight provider IDs, labels, default endpoints and capabilities; remote providers reject first-time empty keys; Ollama accepts an empty key; blank keys retain an already stored credential; unsupported IDs and invalid HTTP(S) endpoints are rejected.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test --test model_provider_service_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement presets and `ModelProviderService`**

Keep presets in code, merge them with saved rows, use `qizhi/model-provider/<provider_id>` for new credentials, preserve legacy credential references, and normalize trailing slashes without guessing non-legacy paths.

- [ ] **Step 4: Run the focused Rust test and verify GREEN**

Run: `cargo test --test model_provider_service_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

### Task 3: Dedicated Tauri Commands and Connection Testing

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/model_provider.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/network/http.rs`
- Test: `apps/desktop/src-tauri/tests/model_provider_commands_test.rs`

**Interfaces:**
- Consumes: `ModelProviderService` from Task 2.
- Produces commands: `list_model_providers`, `save_model_provider`, `test_model_provider`, `activate_model_provider`, `get_active_model_provider`.
- Produces provider test request to `<base>/chat/completions` using the configured model and an optional bearer token.

- [ ] **Step 1: Write failing command contract and URL tests**

Assert camelCase inputs/outputs, correct Chat Completions URLs for all presets, saved-key reuse when the form key is blank, Ollama requests omit Authorization with no key, and failed test calls do not mutate repository state.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test --test model_provider_commands_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: FAIL because the commands are not registered.

- [ ] **Step 3: Implement and register the commands**

Use a minimal non-streaming Chat Completions request with a bounded timeout. Return provider-specific connection messages without logging secrets or response bodies.

- [ ] **Step 4: Run the focused Rust test and verify GREEN**

Run: `cargo test --test model_provider_commands_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

### Task 4: Route Today Summary Through the Active Provider

**Files:**
- Modify: `apps/desktop/src-tauri/src/openai/client.rs`
- Modify: `apps/desktop/src-tauri/src/openai/mod.rs`
- Modify: `apps/desktop/src-tauri/src/commands/summary.rs`
- Modify: `apps/desktop/src-tauri/src/contracts.rs`
- Test: `apps/desktop/src-tauri/tests/openai_summary_test.rs`
- Test: `apps/desktop/src-tauri/tests/summary_commands_test.rs`

**Interfaces:**
- Consumes: active provider resolution and secret lookup from Task 2.
- Produces: provider-aware `ModelClient::from_active_provider` and provider-labelled errors.
- Preserves: `SummaryFileInput`, `SummaryGeneration` and existing Responses/Chat response parsers.

- [ ] **Step 1: Write failing active-provider summary tests**

Assert OpenAI-compatible Responses providers retain the direct-file-first path, Chat-only providers invoke local extraction before HTTP, the selected provider model is used, missing active provider has the new remediation, and errors name the actual provider.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run: `cargo test --test openai_summary_test --test summary_commands_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: FAIL because summary still reads `app_config.openai` and `openai_summary_settings.model`.

- [ ] **Step 3: Implement provider-aware summary client selection**

Retain existing parsing and guardrails. Skip Responses entirely for Chat-only providers; omit bearer auth only for keyless Ollama.

- [ ] **Step 4: Run the focused Rust tests and verify GREEN**

Run: `cargo test --test openai_summary_test --test summary_commands_test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

### Task 5: Model Provider Settings UI

**Files:**
- Create: `apps/desktop/src/features/settings/ModelProviderSettingsSection.tsx`
- Create: `apps/desktop/src/features/settings/ModelProviderSettingsSection.test.tsx`
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx`
- Modify: `apps/desktop/src/features/settings/SummarySettingsSection.tsx`
- Modify: `apps/desktop/src/features/settings/settings.test.tsx`
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/lib/contracts.ts`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Consumes: Task 3 Tauri command contracts.
- Produces: `ModelProviderSettingsSection` with provider selection, endpoint/model/key editing, test, save and activate actions.
- Produces: active provider/model display for `SummarySettingsSection`.

- [ ] **Step 1: Write failing frontend behavior tests**

Cover loading all presets, retaining per-provider form state across selection, leaving activation unchanged after save/test, explicit activation switching the badge, blank-key retention, Ollama key optional behavior, error feedback, and reload restoring the active provider.

- [ ] **Step 2: Run the focused Vitest files and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- ModelProviderSettingsSection.test.tsx settings.test.tsx`

Expected: FAIL because the section and commands do not exist.

- [ ] **Step 3: Implement the settings section and command bindings**

Replace only the OpenAI card. Keep NTFS, JEV and RAGFlow cards unchanged. Use compact provider tabs or a select plus a clear active badge, with model and connection status visible without expanding unrelated settings.

- [ ] **Step 4: Make summary settings read-only for provider/model**

Remove the duplicate model editor while keeping prompt-template editing unchanged. Save only prompt-template changes through a backwards-compatible summary-settings command.

- [ ] **Step 5: Run the focused Vitest files and verify GREEN**

Run: `pnpm --filter @qizhi/desktop test -- ModelProviderSettingsSection.test.tsx settings.test.tsx`

Expected: PASS.

### Task 6: Sidebar Version

**Files:**
- Modify: `apps/desktop/src/components/AppSidebar.tsx`
- Create or Modify: `apps/desktop/src/components/AppSidebar.test.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Produces: sidebar footer text `版本 <x.y.z>` sourced from Tauri application version with `0.1.0` fallback in non-Tauri tests.

- [ ] **Step 1: Write the failing sidebar test**

Assert the footer shows `版本 0.1.0` and does not render “本地优先” or “知识工作空间”.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @qizhi/desktop test -- AppSidebar.test.tsx`

Expected: FAIL because the old tagline is present.

- [ ] **Step 3: Implement version loading and styling**

Read `getVersion()` from `@tauri-apps/api/app`, use a safe test/browser fallback, and keep the footer visually subordinate to the basket control.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @qizhi/desktop test -- AppSidebar.test.tsx`

Expected: PASS.

### Task 7: Documentation, Full Regression and Installer

**Files:**
- Modify: `apps/desktop/src/features/settings/README.md`
- Modify: `apps/desktop/src/features/settings/README_EN.md`
- Modify: `README.md`
- Modify: `README_EN.md`

**Interfaces:**
- Documents provider configuration, one-active-provider behavior, Ollama prerequisites, legacy migration and summary compatibility.

- [ ] **Step 1: Update Chinese and English documentation**

Document the supported providers, where to enter model IDs, how activation differs from saving, and why Chat-only providers use local extraction.

- [ ] **Step 2: Run the complete frontend suite**

Run: `pnpm --filter @qizhi/desktop test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run frontend static checks**

Run: `pnpm --filter @qizhi/desktop check`

Expected: TypeScript, ESLint and Prettier all pass with zero warnings.

- [ ] **Step 4: Run the complete Rust suite**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: all non-environment-specific tests pass.

- [ ] **Step 5: Build the frontend and Windows installer**

Run: `pnpm --filter @qizhi/desktop build`

Run: `pnpm --filter @qizhi/desktop tauri build`

Expected: both exit successfully and produce the NSIS installer under `apps/desktop/src-tauri/target/release/bundle/nsis/`.

- [ ] **Step 6: Verify the final diff and package metadata**

Check that only intended files plus the pre-existing image-discovery changes are present, no API keys appear in the diff, and the installer version matches the sidebar version.
