# Database

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module manages the local SQLite database, ordered migrations, and domain repositories. Stored data includes file metadata, configuration state, value assessments, summary prompts, Codex projects/conversations/materials/artifacts, and handoff records.

Secrets are never stored in SQLite; only service URLs, non-sensitive settings, and credential-presence state belong here. Every schema change must include migration tests that also cover safe re-execution.
