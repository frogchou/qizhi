# Knowledge

[中文](README.md) | [English](README_EN.md) | [Feature modules](../README_EN.md)

This module provides RAGFlow retrieval and Agent conversations. Users may select multiple datasets and Agents; retrieved chunks, final answers, safe execution steps, and source documents are displayed separately. Conversation state is retained for the current app session and cleared when the app exits.

- `KnowledgePage.tsx`: resource selection, streaming conversation, citations, history, and downloads.
- `knowledge.test.tsx`: SSE updates, multiple Agents, session retention, citations, and partial-failure tests.

The UI does not expose private chain-of-thought. It only shows RAGFlow execution status suitable for users. Handoffs to Codex use a backend-issued selection token to prevent forged document identifiers.
