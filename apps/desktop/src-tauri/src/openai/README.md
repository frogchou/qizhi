# OpenAI 兼容服务

[中文](README.md) | [English](README_EN.md) | [Rust 核心](../../README.md)

该模块调用 OpenAI 兼容 Base URL，用于工作总结和模型能力检测。它支持 Responses/兼容响应解析、流式文本增量、内容截断提示和本地文档抽取后的批次总结。

模型名、Base URL 与密钥来自设置；密钥由凭据管理器读取。对外错误不得包含请求正文、文件内容或认证头。
