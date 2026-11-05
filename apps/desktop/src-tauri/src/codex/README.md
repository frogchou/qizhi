# Codex 集成

[中文](README.md) | [English](README_EN.md) | [Rust 核心](../../README.md)

该模块通过本机 Codex CLI 的 app-server 协议管理项目、会话和任务。栖知复用 Codex CLI 的安装、登录、网络、MCP、skills 与插件配置，不保存独立的 OpenAI 登录凭据。

模块负责受管项目目录、资料快照、来源刷新、交接、任务流事件、审批、中断、生成物发现和 RAGFlow 上传。用户资料以快照方式复制到项目上下文，Codex 生成文件保留在项目工作目录。
