# 栖知多模型服务商设计

## 1. 背景与目标

栖知当前把通用大模型连接固定为 `openai` 配置，今日总结直接读取该配置和独立保存的模型名称。用户希望在设置中接入 OpenAI、DeepSeek、千问、Moonshot、智谱、MiniMax、Ollama 等服务，并保证任一时刻只有一个通用模型服务商处于启用状态。

本次改造的目标是：

- 在“连接服务”中管理多个模型服务商，各自保留 Base URL、API Key 和模型名称。
- 同一时刻只启用一个服务商；切换时不删除其他服务商配置。
- 无损迁移现有 OpenAI Base URL、API Key 和今日总结模型。
- 今日总结等既有业务不再依赖写死的 `openai` 配置，而是统一读取当前启用的服务商。
- 针对不同服务商的 API 能力差异采用稳定的降级路径，不因切换服务商破坏总结功能。
- 左侧栏资料筐下方删除“本地优先 / 知识工作空间”，显示应用版本号。

## 2. 非目标

- 本阶段不为每家厂商实现其私有协议、工具调用、联网搜索或图片生成能力。
- 本阶段不自动拉取所有厂商的模型列表；模型 ID 由用户填写，界面提供建议值。
- 本阶段不改变 JEV、RAGFlow、Codex CLI 的连接方式，它们继续使用各自独立配置。
- 本阶段不让多个模型服务商同时参与同一个任务，也不实现自动路由或故障切换。

## 3. 方案选择

### 方案一：统一 OpenAI 兼容供应商层（采用）

为常见供应商提供预设，在统一配置模型中保存连接信息。业务只依赖“当前启用的模型服务商”，协议层根据供应商能力选择 Responses 或 Chat Completions。

优点是复用现有 HTTP、文本提取和总结实现，迁移风险最低；新增兼容服务商只需增加预设及能力声明。

### 方案二：每家供应商使用原生适配器

可以使用厂商全部特色能力，但需要长期跟踪多个私有协议，测试和维护成本显著增加，不适合当前阶段。

### 方案三：只在现有 OpenAI 表单上增加供应商下拉框

实现最小，但切换会覆盖上一家地址、密钥和模型，无法满足“多个服务商配置可保留、只启用一个”的实际使用需求。

## 4. 供应商范围与预设

首批内置以下供应商：

| ID | 界面名称 | 建议 Base URL | 调用策略 |
| --- | --- | --- | --- |
| `openai` | OpenAI / OpenAI 兼容 | `https://api.openai.com/v1` | 优先 Responses 文件输入，失败后本地抽取文本并调用 Chat Completions |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | 优先 Responses；文件输入不兼容时回退 Chat Completions |
| `qwen` | 阿里云百炼 / 千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 本地抽取文本后调用 Chat Completions |
| `moonshot` | Moonshot / Kimi | `https://api.moonshot.cn/v1` | 优先 Responses；文件输入不兼容时回退 Chat Completions |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 本地抽取文本后调用 Chat Completions |
| `minimax` | MiniMax | `https://api.minimax.chat/v1` | 本地抽取文本后调用 Chat Completions |
| `ollama` | Ollama | `http://localhost:11434/v1` | 本地抽取文本后调用 Chat Completions；API Key 可为空 |
| `custom` | 自定义 OpenAI 兼容服务 | 用户填写 | 默认采用 Chat Completions；允许用户选择是否尝试 Responses |

预设地址只用于首次选择，用户可以编辑。模型 ID 同样可编辑，并按供应商显示建议值；实际支持范围以用户账户、地域和服务商当前文档为准。

## 5. 设置界面

“连接服务”保留本地 NTFS、JEV 和 RAGFlow 卡片。原“OpenAI API”卡片改为“模型服务商”区域：

1. 顶部显示当前启用的供应商、模型和连接状态。
2. 供应商选择器列出全部预设；切换选择只切换正在编辑的配置，不立即改变当前启用项。
3. 编辑区包含：供应商名称、Base URL、模型 ID、API Key；自定义服务额外显示“尝试 Responses 文件接口”开关。
4. 操作为“测试连接”“保存配置”“设为当前使用”。
5. “设为当前使用”只在配置完整时可用；切换成功后，其他供应商自动取消启用。
6. API Key 留空保存时保留已有密钥；只有首次配置非 Ollama 服务时要求填写密钥。
7. Ollama 明确提示本地服务通常不需要 API Key，但仍允许用户填写远程 Ollama Cloud 密钥。

“今日总结”设置区继续管理总结模型与提示词，但模型输入改为只读展示当前启用的“供应商 / 模型”，模型 ID 的编辑统一放到“连接服务”，避免两处设置不一致。

## 6. 数据与凭据

新增数据库迁移 `0015_model_providers.sql`：

```text
model_provider_settings
- provider_id TEXT PRIMARY KEY
- display_name TEXT NOT NULL
- endpoint TEXT NOT NULL
- model TEXT NOT NULL
- credential_reference TEXT NOT NULL
- api_key_mask TEXT NOT NULL
- supports_responses INTEGER NOT NULL
- is_active INTEGER NOT NULL
- updated_at_utc_ms INTEGER NOT NULL
```

通过唯一的部分索引保证 `is_active = 1` 最多一行。启用供应商使用一个数据库事务完成“清除旧启用项 + 启用新项”。

API Key 继续保存在 Windows 凭据管理器中，引用格式为 `qizhi/model-provider/<provider_id>`。数据库只保存掩码和凭据引用。

迁移时：

- 若现有 `app_config.service = 'openai'` 存在，则创建 `openai` 供应商记录。
- Base URL、凭据引用与掩码沿用现有值，不复制或暴露密钥。
- 模型名称取自 `openai_summary_settings.model`。
- 该记录设为当前启用项。
- 若没有现有 OpenAI 配置，则仅保留供应商预设，不自动启用任何远程服务。

旧 `app_config` 记录暂不删除，作为版本回滚兼容；新业务不再读取它作为通用模型入口。

## 7. 后端接口

新增模型供应商专用命令，避免把 JEV/RAGFlow 的通用设置接口继续复杂化：

- `list_model_providers()`：返回所有预设与已保存配置、掩码、是否启用。
- `save_model_provider(input)`：校验并保存单个供应商，不改变启用状态。
- `test_model_provider(input)`：使用当前表单内容发起最小 Chat Completions 请求，验证 Base URL、密钥和模型可用性。
- `activate_model_provider(provider_id)`：事务式切换唯一启用项。
- `get_active_model_provider()`：供设置页和今日总结读取。

`test_service_connection` 继续只负责 JEV、RAGFlow 和旧版本兼容，不再承担新增模型供应商测试。

## 8. 模型调用层

将 `OpenAiClient::from_saved_config` 重构为供应商无关的 `ModelClient::from_active_provider`，但保留现有请求解析代码：

- 支持 Responses 的供应商：先尝试当前文件输入流程；仅在明确的端点、参数或文件不支持错误时回退。
- 仅支持 Chat Completions 的供应商：不发送原始文件，直接使用栖知现有的 PDF、Office、Markdown、文本和源码抽取结果。
- Chat Completions 请求继续使用 Bearer 鉴权；Ollama 无密钥时不发送 Authorization 头。
- 错误信息使用供应商显示名称，不再统一写成“OpenAI 失败”。
- 流式 Responses 行为保持不变；Chat Completions 本阶段保持现有完整响应行为，避免扩大本次改造范围。

今日总结的文件选择、批处理、提示词、Markdown 渲染、保存和上传 RAGFlow 流程不变，只替换客户端的配置来源。

## 9. Base URL 规则

新配置把 Base URL 视为完整 API 根地址，调用端仅追加 `responses`、`chat/completions` 或测试所需路径，不猜测厂商路径。

为兼容现有 OpenAI 配置，迁移时如果旧地址只有域名且路径为空，则补全 `/v1`；已有非空路径保持原样。界面保存时去除末尾多余斜杠。

## 10. 版本号显示

侧边栏资料筐下方只显示 `版本 x.y.z`。版本值通过 Tauri 应用 API 读取，与安装包元数据一致；浏览器测试环境使用桌面包版本作为回退。删除“本地优先”和“知识工作空间”两行文案。

## 11. 错误与恢复

- 未启用模型服务商：今日总结提示“请先在设置中启用模型服务商”。
- 启用项配置缺失或密钥失效：保留当前启用项并显示可操作的连接错误，不自动切换供应商。
- 测试失败：不保存、不启用，也不影响当前业务。
- 保存新配置但未启用：当前总结继续使用原供应商。
- Ollama 未启动：明确提示无法连接本地 Ollama，而不是要求填写 API Key。
- 数据库迁移后旧 OpenAI 配置仍可回滚读取，不删除原凭据。

## 12. 测试与验收

后端测试覆盖：

- 旧 OpenAI 配置迁移后仍为当前启用项，Base URL、模型和凭据引用保持有效。
- 任意时刻最多一个启用项。
- 保存其他供应商不会改变当前启用项；显式激活才会切换。
- Ollama 允许空 API Key，远程服务拒绝首次空密钥。
- 各预设生成正确的 Chat Completions URL。
- 今日总结读取当前启用供应商；非 Responses 供应商直接进入本地文本回退路径。
- 错误文案包含实际供应商名称。

前端测试覆盖：

- 左侧栏只显示版本号，不再显示旧两行文案。
- 设置页能切换、保存、测试和启用供应商，且状态清晰。
- 已保存的 API Key 可在不重新输入时保留。
- 同一时间只显示一个“当前使用”。
- 今日总结区展示当前供应商和模型，不再维护第二份模型输入。

完成后运行前端完整测试、TypeScript/ESLint/Prettier 检查、Rust 完整测试和桌面构建。
