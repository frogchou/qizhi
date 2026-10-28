# RAGFlow 知识库问答设计

## 目标

在不上传本地文件、不改动 RAGFlow 资源的前提下，完成一个可用的“选择 RAGFlow 问答机器人并提问”闭环。

## 首发范围

- 在设置中保存 RAGFlow Base URL 与 API Key，密钥仅保存在 Windows 凭据管理器。
- 测试配置并列出用户可访问的 RAGFlow 问答机器人。
- 在“知识库”界面选择一个问答机器人，发送非流式问题并显示回答。
- 每次问题新建 RAGFlow 会话；本地不保存问答内容，避免把知识库内容写入栖知数据库。

## 不在本次范围

- 上传、解析、切片或修改知识库。
- JEV 分析与文件价值判断。
- 流式输出、会话历史、引用文件到 Codex。

## 接口边界

栖知只调用 RAGFlow 的 `GET /api/v1/chats` 与 `POST /api/v1/chat/completions`。请求使用 `Authorization: Bearer`，同时验证 HTTP 状态与响应体的业务 `code`。所有网络请求由 Rust 后端执行，前端从不接触密钥。

## 交互流程

1. 用户在设置填写并测试 RAGFlow Base URL/API Key，保存后界面只显示掩码。
2. 用户进入“知识库”，加载可用问答机器人并选择一个。
3. 输入问题，点击发送；界面等待并展示 RAGFlow 的回答或安全的错误提示。
4. 未配置、无机器人或请求失败时，页面保留可理解的下一步操作说明。

## 安全与可维护性

- API Key 不写入日志、数据库或子进程命令行；通过标准输入传递给 `curl.exe`。
- 限制 Base URL 为 HTTP/HTTPS，拒绝换行与控制字符输入。
- 使用小型 Rust `RagflowClient` 端口封装 HTTP/JSON，命令层与 UI 不依赖具体协议字段。
