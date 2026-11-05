# JEV Value Assessment

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module submits extractable document content to TypeSafe AI JEV and returns a score, verdict, and safe summary using the user's criteria and threshold. Automatic assessment only processes document/text types allowed by the active scan rules.

Content extraction, size limits, duplicate work, and failure state are handled in the backend. Source code, binary files, and excluded paths must not enter assessment because of stale UI state.
