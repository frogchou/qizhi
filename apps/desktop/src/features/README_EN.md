# Frontend Feature Modules

[中文](README.md) | [English](README_EN.md) | [Desktop app](../../README_EN.md)

Each child directory maps to a product area in the sidebar. Pages access Tauri through `QizhiCommands`; they do not access the filesystem, credentials, or external services directly.

| Directory                              | Responsibility                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| [`today/`](today/README_EN.md)         | Today/Recent workspace, directory grouping, value assessment, summaries, and handoffs |
| [`knowledge/`](knowledge/README_EN.md) | RAGFlow retrieval, Agent conversations, citations, and downloads                      |
| [`codex/`](codex/README_EN.md)         | Codex projects, conversations, materials, task progress, and artifacts                |
| [`settings/`](settings/README_EN.md)   | Scan/privacy rules, service connections, prompts, and Codex preferences               |

Component tests live next to module sources. Changes to command payloads must update both `src/lib/tauri.ts` and the Rust command boundary.
