# Qizhi Desktop

[中文](README.md) | [English](README_EN.md) | [Project home](../../README_EN.md)

This directory contains the Tauri 2 desktop app, combining a React/TypeScript UI with a Rust application core.

## Layout

- `src/`: app shell, shared components, Tauri command types, and feature pages.
- `src/features/`: the four primary product areas: Today, Knowledge, Codex Workspace, and Settings.
- `src-tauri/`: Rust commands, database, NTFS index service, external-service clients, and packaging configuration.
- `e2e/`: Playwright tests for critical workflows.
- `public/`: frontend static assets.

## Common Commands

```powershell
pnpm --filter @qizhi/desktop dev
pnpm --filter @qizhi/desktop check
pnpm --filter @qizhi/desktop test -- --run
pnpm --filter @qizhi/desktop e2e
pnpm --filter @qizhi/desktop tauri dev
pnpm --filter @qizhi/desktop tauri build
```

Cross-boundary contracts are defined by `src/lib/tauri.ts` and `src-tauri/src/commands/`. New fields require both TypeScript and Rust boundary tests; frontend-facing field names use camelCase consistently.
