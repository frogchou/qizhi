# Settings

[中文](README.md) | [English](README_EN.md) | [Feature modules](../README_EN.md)

This module manages scan/privacy rules, OpenAI-compatible services, JEV, RAGFlow, Codex preferences, and work-summary prompts.

- `SettingsPage.tsx`: settings layout, connection tests, and scan-folder selection.
- `SummarySettingsSection.tsx`: add/remove summary prompts and choose a default.
- `CodexSettingsSection.tsx`: Codex CLI status, model, and reasoning effort.

Secret inputs are written only to Windows Credential Manager; reloading settings returns masked state rather than plaintext. Directories are added through the system picker, and saving must provide clear feedback and immediately affect Today queries.
