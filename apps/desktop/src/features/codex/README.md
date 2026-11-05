# Codex 工作

[中文](README.md) | [English](README_EN.md) | [功能模块](../README.md)

该模块在栖知内提供接近 Codex 的项目与会话体验。它只面向本机已安装并登录 Codex CLI 的用户，复用本机登录状态，不要求在栖知中再次登录。

- `CodexPage.tsx`：项目、会话、运行状态与整体编排。
- `CodexConversation.tsx`：消息、过程事件、审批和中断。
- `CodexContextPanel.tsx`：项目资料、来源状态和刷新。
- `CodexPendingMaterials.tsx`：从今日或知识库发送来的待处理资料。
- `CodexArtifactUploadDialog.tsx`：把生成物上传至 RAGFlow。
- `CodexDestinationDialog.tsx`：选择目标项目和会话并确认资料快照。

项目工作目录由后端管理。网络、MCP、skills 和 Codex 插件沿用用户本机 Codex 配置，不在前端额外禁用。
