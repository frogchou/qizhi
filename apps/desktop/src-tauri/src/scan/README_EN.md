# Scan and Privacy Rules

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module decides which indexed records may enter the user's workspace. Allowed roots, user exclusions, locked system exclusions, file categories, and the directory-grouping threshold form the scan policy.

Exclusions take precedence over allowed roots. Binary/library files and types unsupported by content extraction do not enter document analysis. Query and assessment paths share the same saved rules to prevent UI filtering from diverging from backend processing.
