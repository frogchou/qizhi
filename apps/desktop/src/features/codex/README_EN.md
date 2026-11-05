# Codex Workspace

[中文](README.md) | [English](README_EN.md) | [Feature modules](../README_EN.md)

This module provides a Codex-like project and conversation experience inside Qizhi. It is available to users who already have the Codex CLI installed and authenticated locally; Qizhi reuses that local account state and does not require a separate sign-in.

- `CodexPage.tsx`: project, conversation, runtime state, and orchestration.
- `CodexConversation.tsx`: messages, process events, approvals, and interruption.
- `CodexContextPanel.tsx`: project materials, source status, and refresh.
- `CodexPendingMaterials.tsx`: pending materials sent from Today or Knowledge.
- `CodexArtifactUploadDialog.tsx`: upload generated artifacts to RAGFlow.
- `CodexDestinationDialog.tsx`: choose a destination project/conversation and confirm snapshots.

The backend manages project working directories. Network access, MCP, skills, and Codex plugins follow the user's local Codex configuration and are not disabled by the frontend.
