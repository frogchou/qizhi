# Qizhi

[中文](README.md) | [English](README_EN.md)

Qizhi is a local-first work assistant for Windows knowledge workers. It uses a built-in NTFS/USN index to discover recent file activity, turns scattered documents into searchable and reusable work context, and integrates with RAGFlow, OpenAI-compatible services, TypeSafe AI JEV, and the local Codex CLI.

> Qizhi is currently an early-stage project (`0.1.0`). APIs, data formats, and installation behavior may change. Use it in a test environment first.

## Highlights

- **Today and Recent**: discover changed files from NTFS records, group them by directory, filter, search, sort, and select them in batches.
- **Value assessment**: automatically evaluate eligible documents with JEV using user-configurable criteria and thresholds.
- **Work summaries**: send selected files to an OpenAI-compatible model and stream Markdown summaries based on reusable prompt templates.
- **Knowledge Q&A**: retrieve RAGFlow knowledge, ask one or more Agents, show citations, and download source documents.
- **Codex workspace**: manage local Codex CLI projects and conversations, hand off local or RAGFlow materials to an isolated task directory, and upload artifacts back to RAGFlow.
- **Local-first privacy controls**: users control scan roots, exclusions, and file types; secrets are stored in Windows Credential Manager.

## Product Areas

| Area            | Purpose                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| Today / Recent  | Discover, group, and act on recent work files                                |
| Knowledge       | RAGFlow retrieval, Agent Q&A, citations, and downloads                       |
| Codex Workspace | Local Codex projects, conversations, materials, and artifacts                |
| Settings        | Scan/privacy rules, model services, RAGFlow, JEV, Codex, and summary prompts |

See the [desktop app guide](apps/desktop/README_EN.md), [frontend feature map](apps/desktop/src/features/README_EN.md), and [Rust/Tauri core guide](apps/desktop/src-tauri/README_EN.md) for implementation details.

## Architecture

```text
React + TypeScript UI
        │ Tauri commands / events
Rust application core
  ├─ NTFS/USN index service + SQLite
  ├─ RAGFlow / OpenAI / JEV HTTP clients
  ├─ Windows Credential Manager
  └─ Codex CLI app-server integration
```

Everything is not a runtime dependency. Qizhi ships its own Windows NTFS/USN indexing service. Non-NTFS locations and unsupported environments use capability-based fallbacks.

## Requirements

- Windows 10/11 x64; NTFS volumes are required for full indexing support
- Node.js 20 or later
- pnpm 11 (the workspace declares `pnpm@11.7.0`)
- Rust stable and the Windows MSVC build tools
- Microsoft Edge WebView2 Runtime
- Optional: a locally installed and authenticated Codex CLI for Codex Workspace
- Optional: RAGFlow, an OpenAI-compatible service, and TypeSafe AI JEV for their respective online features

## Local Development

```powershell
pnpm install
pnpm check
pnpm test -- --run
pnpm --filter @qizhi/desktop tauri dev
```

Build the frontend and Windows installer:

```powershell
pnpm --filter @qizhi/desktop build
pnpm --filter @qizhi/desktop tauri build
```

Run Rust tests:

```powershell
cd apps/desktop/src-tauri
cargo test
```

## Configuration and Security

Save service URLs and API keys only through the in-app Settings page. Never place real keys in `.env` files, source code, tests, documentation, logs, or issue reports. Local databases, logs, credential exports, build output, and package-manager caches are ignored by default.

Installing the built-in indexing service requires Windows administrator confirmation. Scanning is limited to user-approved roots, while system and user exclusions always take precedence.

## Repository Layout

```text
apps/desktop/              Tauri desktop application
  src/                     React/TypeScript frontend
    features/              Today, Knowledge, Codex, and Settings
  src-tauri/               Rust core, Windows service, and installer configuration
docs/                      Architecture, testing, release, and design records
```

## Testing and Release

- Frontend unit/component tests: Vitest + Testing Library
- End-to-end tests: Playwright
- Rust unit/integration tests: Cargo test
- Manual release checks: [Stage 0–1 checklist](docs/testing/stage-0-1-manual-checklist.md)

Remove file paths, personal information, knowledge-base content, and credentials from logs before filing an issue.

## Project Status and License

Qizhi is under active development. Reproducible bugs and proposals are welcome in [GitHub Issues](https://github.com/frogchou/qizhi/issues).

This repository does not yet include an open-source license. The project owner must select and add one before a formal public release; until then, no permission to copy, modify, or distribute the code is granted automatically.
