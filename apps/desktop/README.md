# 栖知桌面端

[中文](README.md) | [English](README_EN.md) | [返回项目首页](../../README.md)

本目录是栖知的 Tauri 2 桌面应用，由 React/TypeScript 界面和 Rust 核心组成。

## 目录

- `src/`：应用壳、共享组件、Tauri 命令类型和功能页面。
- `src/features/`：今日、知识库、Codex 工作和设置四个主要产品模块。
- `src-tauri/`：Rust 命令、数据库、NTFS 索引服务、外部服务客户端和安装配置。
- `e2e/`：Playwright 关键流程测试。
- `public/`：前端静态资源。

## 常用命令

```powershell
pnpm --filter @qizhi/desktop dev
pnpm --filter @qizhi/desktop check
pnpm --filter @qizhi/desktop test -- --run
pnpm --filter @qizhi/desktop e2e
pnpm --filter @qizhi/desktop tauri dev
pnpm --filter @qizhi/desktop tauri build
```

跨前后端数据通过 `src/lib/tauri.ts` 和 `src-tauri/src/commands/` 形成明确契约。新增字段时需要同时增加 TypeScript 与 Rust 边界测试，字段名统一使用前端 camelCase。
