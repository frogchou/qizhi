# Codex Integration

[中文](README.md) | [English](README_EN.md) | [Rust core](../../README_EN.md)

This module manages projects, conversations, and turns through the local Codex CLI app-server protocol. Qizhi reuses the CLI's installation, authentication, network, MCP, skills, and plugin configuration; it stores no separate OpenAI login credentials.

It owns managed project directories, material snapshots, source refresh, handoffs, turn events, approvals, interruption, artifact discovery, and RAGFlow uploads. User materials are copied into project context as snapshots, while Codex-generated files remain in the managed project workspace.
