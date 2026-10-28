# RAGFlow Agents 与知识检索设计

## 意图

把“知识库”从旧的单一 Chat Assistant 问答改为可验证、只读的工作台：用户用同一个关键词同时查看 RAGFlow 知识库检索片段，并向一个或多个 RAGFlow Agents 发起问题，分别阅读每个 Agent 的回答。

## 目标

- 设置页保存扫描规则后明确显示成功或失败，并显示当前生效的扫描范围、排除目录和文件类型数量。
- “今日”把正在进行的同一轮扫描显示为进度，而不是误报“刷新未完成”；保存排除规则后，返回“今日”时缓存记录立即按新规则过滤。
- 知识库页列出用户可访问的数据集和 Agents，允许分别多选。
- 对已选数据集调用 `POST /api/v1/retrieval`，展示最多 10 条相关片段、来源文件名和相似度。
- 对每个已选 Agent 调用 `POST /api/v1/agents/chat/completions`（`stream: false`），在独立结果卡片显示回答或该 Agent 的错误。
- 每次查询使用新的 Agent 会话；本地不保存查询、片段或回答。

## 非目标

- 不上传或修改 RAGFlow 数据集、文档、Agent、会话或工作流。
- 不实现 Agent 流式输出、Agent Begin 组件的自定义输入字段、会话历史或本地全文索引。
- 不把知识库检索结果自动注入 Agent；Agent 自身能否检索由其 RAGFlow 工作流决定。

## 方案比较

1. 继续使用 Chat Assistant：改动小，但不能满足用户使用 Agents 和直接选知识库检索的需求。
2. 单一工作台：同一输入并行触发检索和多 Agent 调用，结果分栏显示。用户能对比原始片段与各 Agent 推理，且只读边界清楚。
3. 分成“检索”和“Agent”两个页面：流程更隔离，但重复输入、用户无法快速对照同一次查询结果。

本次采用方案 2。检索与 Agents 相互独立：未选择任一项时不会触发对应请求；至少选择一个数据集或 Agent 才可查询。

## 接口边界

RAGFlow HTTP 调用均在 Rust 后端完成，使用已保存的 Windows 凭据，不将 API Key 传入前端、日志或进程命令行：

- `GET /api/v1/datasets?page=1&page_size=100`
- `GET /api/v1/agents?page=1&page_size=100`
- `POST /api/v1/retrieval`，传入 `question`、用户所选 `dataset_ids`、`page: 1`、`page_size: 10`、`highlight: true`
- `POST /api/v1/agents/chat/completions`，传入 `agent_id`、`question`、`stream: false`

后端验证 HTTP 状态和 RAGFlow 业务 `code`；Agent 返回采用原生非流式结构。列表解析需兼容当前文档格式与旧服务的扁平数组格式。

## 交互流程

1. 用户在设置页保存扫描规则，立即收到绿色成功提示；保存失败收到可操作错误。
2. 用户进入“今日”时若扫描已在运行，页面订阅现有进度并在完成后重读缓存，不显示失败提示。
3. 用户进入“知识库”，加载可访问的数据集和 Agents；每项用复选框选择。
4. 输入关键词，点击“查询”。后端并行执行已选的数据集检索与所有已选 Agent 调用。
5. 页面分别展示“相关内容”和“Agent 回答”，每个 Agent 独立显示加载失败或答案。

## 安全与验收

- API Key 不写入页面、日志、数据库或命令行。
- 没有选中数据集或 Agent 时不发送网络请求，并给出明确提示。
- 单个 Agent 失败不得丢弃其他 Agent 的成功回答或检索片段。
- 新排除目录会立即从缓存“今日”列表消失；同轮并发刷新不显示误导性失败。
