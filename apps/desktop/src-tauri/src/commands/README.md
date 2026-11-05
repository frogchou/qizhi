# Tauri 命令边界

[中文](README.md) | [English](README_EN.md) | [Rust 核心](../../README.md)

本目录把前端请求转换为领域服务调用，负责反序列化、输入校验、权限/来源约束和用户可读错误。命令函数保持薄层，复杂逻辑放在对应领域模块。

前端字段统一为 camelCase；Rust 结构使用 Serde 明确重命名。每个跨边界载荷都应有 JSON 契约测试，避免 TypeScript 类型正确但运行时反序列化失败。
