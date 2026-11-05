# Rust / Tauri 核心

[中文](README.md) | [English](README_EN.md) | [桌面端](../README.md)

此目录包含栖知的可信应用核心、Windows 索引服务和安装配置。React 端只能通过 `src/commands/` 暴露的 Tauri 命令访问这些能力。

## 主要模块

| 模块                                  | 职责                                      |
| ------------------------------------- | ----------------------------------------- |
| [`commands/`](src/commands/README.md) | 前端命令边界、输入验证和用户可读错误      |
| [`ntfs/`](src/ntfs/README.md)         | NTFS 元数据快照、USN 增量同步、服务与 IPC |
| [`scan/`](src/scan/README.md)         | 扫描范围、排除规则、文件类型和进度        |
| [`database/`](src/database/README.md) | SQLite 迁移与领域仓储                     |
| [`ragflow/`](src/ragflow/README.md)   | 知识库、Agent、上传、下载和检索 API       |
| [`openai/`](src/openai/README.md)     | OpenAI 兼容摘要与内容抽取                 |
| [`jev/`](src/jev/README.md)           | JEV 文档价值评估                          |
| [`codex/`](src/codex/README.md)       | Codex CLI app-server、项目资料和生成物    |
| `config/`                             | 配置校验与 Windows 凭据管理器             |
| `telemetry/`                          | 本地日志与敏感信息脱敏                    |

## 约束

- 所有外部输入在命令或客户端边界验证。
- 密钥不进入 SQLite、日志或返回给前端的明文结构。
- 文件操作必须先经过扫描规则、查询快照或项目根目录约束。
- Windows 特有实现保留可测试的纯逻辑层；集成测试位于 `tests/`。

运行验证：`cargo fmt --check`、`cargo test`。
