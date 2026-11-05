# RAGFlow 集成

[中文](README.md) | [English](README_EN.md) | [Rust 核心](../../README.md)

该模块封装 RAGFlow HTTP API：连接检测、知识库与 Agent 列表、检索、原生流式 Agent 事件、文件上传/下载和解析启动。

不同 RAGFlow 版本可能返回不同包裹结构，因此解析器在保留严格错误报告的同时兼容已验证的响应形态。引用、文档标识和 Agent session 都在此层规范化，前端不拼接接口 URL。
