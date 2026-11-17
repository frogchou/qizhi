# Database

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module manages the local SQLite database, ordered migrations, and domain repositories. Stored data includes file metadata, configuration state, value assessments, summary prompts, Codex projects/conversations/materials/artifacts, and handoff records.

Migration 14 adds the material basket. SQLite stores each item's name, hashed source identity, checksum, size and timestamp. A UUID-named file in the application's `material-basket` directory holds the original bytes. Items appear after the copy is complete. Matching source and content are deduplicated. Changed sources can produce new snapshots. Removing a basket item preserves copies attached to Codex projects. Factory uploads use the current bound connection. Temporary local attachments are opened only after native file selection.

Secrets are never stored in SQLite; only service URLs, non-sensitive settings, and credential-presence state belong here. Every schema change must include migration tests that also cover safe re-execution.
