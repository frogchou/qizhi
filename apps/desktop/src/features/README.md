# 前端功能模块

[中文](README.md) | [English](README_EN.md) | [桌面端](../../README.md)

每个子目录对应侧边栏中的一个产品区域。页面通过 `QizhiCommands` 访问 Tauri，不直接访问文件系统、凭据或外部服务。

| 目录                                | 职责                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| [`today/`](today/README.md)         | 今日/过去文件工作台、目录聚合、价值评估、总结与资料交接 |
| [`knowledge/`](knowledge/README.md) | RAGFlow 检索、Agent 会话、引用与资料下载                |
| [`codex/`](codex/README.md)         | Codex 项目、会话、资料、任务过程与生成物                |
| [`settings/`](settings/README.md)   | 扫描、隐私、服务连接、提示词和 Codex 偏好               |

组件测试与模块源文件放在同一目录。涉及命令载荷的改动必须同步更新 `src/lib/tauri.ts` 和 Rust 命令边界。
