# 栖知 Qizhi

[中文](README.md) | [English](README_EN.md)

栖知是一款面向 Windows 知识工作者的本地优先工作助手。它使用内置的 NTFS/USN 索引快速发现近期文件变动，把分散的文档整理成可检索、可总结、可继续处理的工作上下文，并连接 RAGFlow、OpenAI 兼容服务、TypeSafe AI JEV 与本机 Codex CLI。

> 当前处于早期开发阶段（`0.1.0`）。接口、数据结构和安装方式仍可能变化，请先在测试环境中使用。

## 核心能力

- **今日与过去**：根据 NTFS 变更记录发现文件，按目录聚合、筛选、搜索、排序和批量选择。
- **价值评估**：使用 JEV 对符合规则的文档自动判断价值；规则与阈值由用户设置。
- **工作总结**：把选中的文件交给 OpenAI 兼容模型，按可复用提示词流式生成 Markdown 总结。
- **知识库问答**：检索 RAGFlow 知识库，同时向一个或多个 Agent 提问，展示引用资料与可下载来源。
- **Codex 工作**：基于本机 Codex CLI 管理项目和会话，将本地文件或知识库资料发送到独立任务目录，并把生成物上传回 RAGFlow。
- **本地优先与隐私控制**：扫描范围、排除目录和文件类型由用户控制；密钥保存在 Windows 凭据管理器中。

## 产品结构

| 模块        | 作用                                                   |
| ----------- | ------------------------------------------------------ |
| 今日 / 过去 | 发现、聚合和处理近期工作文件                           |
| 知识库      | RAGFlow 检索、Agent 问答、引用和资料下载               |
| Codex 工作  | 本机 Codex 项目、会话、资料和生成物管理                |
| 设置        | 扫描与隐私、模型服务、RAGFlow、JEV、Codex 与总结提示词 |

更详细的代码地图见 [桌面端说明](apps/desktop/README.md)、[前端功能模块](apps/desktop/src/features/README.md) 和 [Rust/Tauri 核心](apps/desktop/src-tauri/README.md)。

## 技术架构

```text
React + TypeScript UI
        │ Tauri commands / events
Rust application core
  ├─ NTFS/USN index service + SQLite
  ├─ RAGFlow / OpenAI / JEV HTTP clients
  ├─ Windows Credential Manager
  └─ Codex CLI app-server integration
```

Everything 不是运行依赖。栖知包含自己的 Windows NTFS/USN 索引服务；非 NTFS 位置和不支持的环境会按能力降级。

## 环境要求

- Windows 10/11 x64，NTFS 磁盘用于完整索引能力
- Node.js 20 或更新版本
- pnpm 11（仓库声明 `pnpm@11.7.0`）
- Rust stable 与 Windows MSVC 构建工具
- Microsoft Edge WebView2 Runtime
- 可选：本机安装并登录 Codex CLI，用于“Codex 工作”
- 可选：RAGFlow、OpenAI 兼容服务和 TypeSafe AI JEV，用于相应在线能力

## 本地开发

```powershell
pnpm install
pnpm check
pnpm test -- --run
pnpm --filter @qizhi/desktop tauri dev
```

构建前端与 Windows 安装包：

```powershell
pnpm --filter @qizhi/desktop build
pnpm --filter @qizhi/desktop tauri build
```

Rust 测试：

```powershell
cd apps/desktop/src-tauri
cargo test
```

## 配置与安全

服务地址和密钥只应通过应用的“设置”页面保存。不要把真实密钥写入 `.env`、源代码、测试、文档、日志或问题反馈。默认忽略本地数据库、日志、凭据导出、构建目录和包管理缓存。

首次安装内置索引服务需要 Windows 管理员确认。扫描仅在用户允许的目录中进行，系统目录和用户排除目录优先于允许范围。

## 仓库结构

```text
apps/desktop/              Tauri 桌面应用
  src/                     React/TypeScript 前端
    features/              今日、知识库、Codex、设置
  src-tauri/               Rust 核心、Windows 服务与安装配置
docs/                      架构、测试、发布与设计记录
```

## 测试与发布

- 前端单元/组件测试：Vitest + Testing Library
- 端到端测试：Playwright
- Rust 单元/集成测试：Cargo test
- 手工发布检查：[阶段 0–1 清单](docs/testing/stage-0-1-manual-checklist.md)

提交问题时请删除日志中的文件路径、个人资料、知识库内容和服务凭据。

## 项目状态与许可证

项目正在快速迭代，欢迎通过 [GitHub Issues](https://github.com/frogchou/qizhi/issues) 提交可复现的问题和建议。

仓库目前尚未包含开源许可证。在正式公开发布前需要由项目所有者选择并添加许可证；在此之前，不自动授予复制、修改或分发代码的权利。
