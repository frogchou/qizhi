# 知识库

[中文](README.md) | [English](README_EN.md) | [功能模块](../README.md)

该模块提供 RAGFlow 资料检索和 Agent 对话。用户可多选知识库与 Agent；检索片段、最终回答、可公开的执行步骤和资料引用分别展示。会话状态在应用运行期间保留，退出应用后清空。

- `KnowledgePage.tsx`：资源选择、流式会话、引用、历史和下载。
- `knowledge.test.tsx`：SSE 更新、多 Agent、会话保留、引用与错误隔离测试。

界面不会展示模型的私有思维链；只展示 RAGFlow 返回且适合用户查看的执行状态。向 Codex 发送资料时使用后端签发的选择令牌，防止伪造文档标识。
