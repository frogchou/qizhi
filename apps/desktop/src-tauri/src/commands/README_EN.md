# Tauri Command Boundary

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This directory translates frontend requests into domain-service calls and owns deserialization, input validation, authorization/provenance checks, and user-safe errors. Command functions stay thin; complex logic belongs in the relevant domain module.

Frontend fields use camelCase consistently, with explicit Serde renaming on Rust types. Every cross-boundary payload should have a JSON contract test so a valid TypeScript type cannot still fail at runtime.
