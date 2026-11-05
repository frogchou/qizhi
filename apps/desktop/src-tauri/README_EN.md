# Rust / Tauri Core

[中文](README.md) | [English](README_EN.md) | [Desktop app](../README_EN.md)

This directory contains Qizhi's trusted application core, Windows indexing service, and packaging configuration. The React UI reaches these capabilities only through Tauri commands exposed from `src/commands/`.

## Main Modules

| Module                                   | Responsibility                                                    |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [`commands/`](src/commands/README_EN.md) | Frontend command boundary, input validation, and user-safe errors |
| [`ntfs/`](src/ntfs/README_EN.md)         | NTFS metadata snapshots, USN incremental sync, service, and IPC   |
| [`scan/`](src/scan/README_EN.md)         | Scan roots, exclusions, file categories, and progress             |
| [`database/`](src/database/README_EN.md) | SQLite migrations and domain repositories                         |
| [`ragflow/`](src/ragflow/README_EN.md)   | Dataset, Agent, upload, download, and retrieval APIs              |
| [`openai/`](src/openai/README_EN.md)     | OpenAI-compatible summaries and content extraction                |
| [`jev/`](src/jev/README_EN.md)           | JEV document value assessment                                     |
| [`codex/`](src/codex/README_EN.md)       | Codex CLI app-server, project materials, and artifacts            |
| `config/`                                | Configuration validation and Windows Credential Manager           |
| `telemetry/`                             | Local logging and secret redaction                                |

## Constraints

- Validate all external input at command or client boundaries.
- Never persist secrets in SQLite/logs or return them to the UI in plaintext.
- Gate file operations by scan rules, query snapshots, or managed project roots.
- Keep Windows-specific code behind testable pure logic; integration tests live in `tests/`.

Run `cargo fmt --check` and `cargo test` for verification.
