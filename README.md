# 栖知

面向职场人士的 Windows 本地优先工作知识助手。当前开发阶段提供安全设置、内置 Windows NTFS/USN 元数据索引和“今日”文件工作台；不需要安装或启动 Everything，也不会调用模型、RAGFlow 或 Codex 的业务接口。

## 本地开发

1. 安装 Node.js、pnpm 和 Rust stable 工具链。
2. 运行 `pnpm install`。
3. 运行 `pnpm --filter @qizhi/desktop check` 和 `pnpm --filter @qizhi/desktop test -- --run`。
4. 运行 `pnpm --filter @qizhi/desktop e2e`。
5. 运行 `pnpm --filter @qizhi/desktop tauri dev`。

密钥只能在应用设置中输入；不得写入 `.env`、文档、日志或版本控制。

发布验收请参阅 [阶段 0–1 清单](docs/testing/stage-0-1-manual-checklist.md)。
