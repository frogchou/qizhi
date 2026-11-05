# 知识库对话与 Agent 流式输出设计

## 意图

把现有“提交问题后等待整块结果”的知识库页面，升级为符合主流对话产品习惯的连续问答界面。用户应能清楚区分自己的问题、知识库检索结果和各个 Agent 的回答；长时间运行时能立即看到进展；Agent 的执行过程默认收起，避免过程信息淹没最终答案。

## 目标

- 用户消息靠右，检索和 Agent 回答靠左，一问一答层次明确。
- 用户消息与模型回答都提供复制和“放回输入框”操作；该操作不修改或删除历史。
- RAGFlow Agent 使用原生 SSE 流式接口，多个 Agent 并行输出且互不阻塞。
- Agent 的可解释执行事件默认折叠，用户主动展开后查看。
- Enter 发送；Shift+Enter 换行；中文输入法选词期间 Enter 不发送。
- 回答按 Markdown 渲染，流式追加时保持可读并自动跟随到底部。
- 保留知识库直接检索、引用来源和原文件下载能力。
- 后续问题延续每个 Agent 的 RAGFlow session，使页面上的连续问答具备真实上下文。

## 非目标

- 本阶段不把聊天历史持久化到本地数据库，关闭应用后无需恢复。
- 不提供删除、覆盖或分叉历史消息。
- 不展示模型不可验证的私有思维链。界面只展示 RAGFlow 提供的节点执行、检索和工具进度，统一称为“执行过程”。
- 不实现停止生成、重新生成、语音输入或附件上传。
- 不改变右侧知识库和 Agents 的选择方式。

## 约束

- 继续使用现有 Tauri、React、Rust、`reqwest::blocking` 和 Tauri `Channel`，不引入新的前端状态库。
- 凭据仍只由 Rust 端读取，前端不得接触 RAGFlow API Key。
- 使用 RAGFlow 当前规范端点 `POST /api/v1/agents/chat/completions`。
- 原生 Agent 请求使用 `stream: true`、`return_trace: true`，并在后续轮次携带对应 `session_id`。
- 请求可携带 `chat_template_kwargs.enable_thinking: false` 以减少非必要思考输出，但客户端仍必须解析思考边界，不能依赖模型遵守该开关。
- 兼容返回 SSE 的当前服务；若旧服务在 `stream: true` 下返回单个 JSON，必须明确降级解析，不能把完整回答误报为连接错误。
- 所有 Agent 事件必须按 `agent_id` 隔离，多 Agent 并行时不能把文本或执行过程串到另一个回答中。
- 单个执行步骤的展示文本必须做长度上限和凭据脱敏，不能把完整内部对象或密钥直接传给前端。

## 已考虑的实现方式

### 方案 1：RAGFlow 原生 SSE 与执行事件（采用）

Rust 端解析 `message`、`message_end`、`node_finished` 和结束事件，通过 Tauri Channel 推送结构化事件。它能提供真实首字延迟、Agent 节点过程和 session 延续，最符合本次目标，但需要完善 SSE 解析、并发事件和前端增量状态。

### 方案 2：OpenAI 兼容流式接口

文本增量格式简单，但 Agent 节点事件和执行轨迹不完整，不能可靠实现折叠过程，因此不采用。

### 方案 3：完整响应后在前端模拟逐字播放

改动最小，但用户仍需等待完整请求，且没有真实执行进度，不采用。

## 用户界面

### 对话布局

- 每轮由右侧用户消息和一组左侧回答组成。
- 用户消息最大宽度约为对话区的 70%，使用浅绿色气泡并右对齐；不再显示占位“你”头像。
- 每个 Agent 单独显示一条左侧回答，包含 Agent 图标、名称、生成状态、Markdown 内容和消息操作。
- 仅选择知识库时，左侧显示一条“知识库检索”回答，简要说明找到多少条资料，并附折叠引用来源。
- 同时选择知识库和 Agents 时，引用来源归属于该轮对话，置于所有 Agent 回答之后，避免每个 Agent 重复展示。
- 某个 Agent 失败只使该 Agent 卡片显示错误；其他 Agent 和检索结果继续完成。

### 消息操作

- 消息悬停或键盘聚焦时显示“复制”和“编辑”按钮。
- 用户消息的复制内容为原问题；Agent 消息的复制内容为最终回答 Markdown 原文。
- 点击任意消息的“编辑”只把原文写入底部输入框并聚焦，不改变原消息、后续消息或 RAGFlow session。
- 若输入框已有内容，编辑操作直接替换输入框内容；这是用户已确认的行为。
- 成功复制后显示短暂的非阻塞反馈。

### 执行过程

- 每个 Agent 回答下方有一个默认关闭的 `<details>`：“执行过程（N）”。
- `node_finished` 生成一个步骤，展示节点名称/类型、完成或失败状态、耗时以及经过裁剪、脱敏的摘要。
- 流式 `message` 只进入最终回答，不进入执行过程。
- 没有执行事件时不显示该折叠区。
- 执行过程不是思维链；界面和代码均使用 `trace`/`step`/“执行过程”命名。

### 输入框与滚动

- Enter 在非组合输入状态下发送；Shift+Enter 插入换行。
- 空问题、未选择任何资源或已有查询进行中时不发送。
- `isComposing` 或原生 `event.isComposing` 为真时，Enter 保持输入法行为。
- 新增消息和流式增量到达时，仅当用户本来位于底部附近时自动跟随；用户向上阅读时不强制拉回底部。
- 点击历史消息“编辑”后滚动到底部并聚焦输入框。

## 数据模型

前端每轮保存：

```text
ConversationTurn {
  id,
  question,
  status,
  chunks,
  agents: AgentConversationState[]
}

AgentConversationState {
  agentId,
  status: pending | streaming | completed | failed,
  answerMarkdown,
  steps: AgentExecutionStep[],
  error,
  sessionId
}
```

页面另保存 `agentSessions: Map<agentId, sessionId>`。发起下一轮时，只为当前选中的 Agent 携带其最近 session；完成事件返回新 session 后更新映射。

查询输入新增 `agentSessions: Record<agentId, sessionId>`，仅包含当前选中的 Agent。最终 `RagflowKnowledgeQuery` 是权威快照，包含 `chunks`、`retrievalError`，以及每个 Agent 的 `answer`、`error`、`sessionId`、`sessionInvalid` 和安全执行步骤。前端收到最终 Promise 后按 Agent ID 替换/合并状态，绝不再次追加答案文本。

Tauri Channel 事件采用带 `kind` 的联合类型：

```text
retrievalStarted
retrievalCompleted { chunks }
retrievalFailed { error }
agentStarted { agentId }
agentAnswerReset { agentId, messageId }
agentDelta { agentId, delta }
agentThinking { agentId, active }
agentStep { agentId, step }
agentCompleted { agentId, sessionId }
agentFailed { agentId, error, sessionInvalid }
completed
```

命令最终仍返回完整 `RagflowKnowledgeQuery`，用于通道丢失后的最终收敛和测试；前端事件处理必须幂等，最终返回不能重复拼接已经收到的增量。所有事件由本次调用闭包绑定到 `turnId`，使用 functional reducer 更新；同一 Agent 保序，不同 Agent 允许交错。

## Rust 流式实现

1. `HttpClient` 复用现有逐行读取能力，按 SSE 空行组装事件，支持多条 `data:`、`:heartbeat`、`event`、`id`、`retry` 和 `[DONE]`。读取响应 `Content-Type`，同时用内容探测兜底错误标注的服务。
2. SSE 路径不无限保留整个响应；只维护有界的单事件缓冲。仅在服务返回非 SSE 时，用有界完整缓冲解析旧版 JSON。
3. `RagflowClient::ask_agent_streaming` 构造原生 Agent 请求并将解析后的事件交给回调。它识别 SSE 内业务 `code/message` 和 error 事件。
4. 每个 Agent 流维护思考状态机：识别 `start_to_think`、`end_to_think` 及兼容的 `<think>` 标记。思考内容不进入 `answerMarkdown`、不传到前端；只发送“模型思考中/完成”的状态。即使缺少结束标志，也不能把之后无法确认的私有推理当最终回答。
5. `message` 按 `message_id` 缓冲。首次消息成为当前答案候选；出现新的 `message_id` 时发送 `agentAnswerReset` 并以新消息替代旧候选，避免多个 Message 组件的中间输出串成最终答案。旧候选正文不进入执行过程。
6. `node_finished` 及旧服务的 `component_finished` 别名转为安全步骤。只读取节点名称/类型、状态、耗时和脱敏错误等白名单字段，不序列化完整 inputs、outputs 或 trace。
7. 从每个事件顶层读取 `session_id`，不能只依赖 `message_end`。Agent 自带 reference 本阶段不展示；引用区继续只展示 `/retrieval` 返回、可去重和下载的 chunks。
8. 知识库检索和所有去重后的 Agent ID 同时启动。事件携带 `agent_id`；重复 Agent ID 在 Rust 端去重，防止相互污染。
9. 命令等待检索和所有 Agent 线程结束后才发送顶层 `completed`。线程 panic/join 失败也转为对应 `agentFailed`，不能静默丢失结果。
10. 单个 Agent 或检索失败不使整轮失败。最终输出带 `retrievalError`，并为每个选中 Agent 保留成功或失败结果。
11. HTTP 非 2xx、业务错误、流中断和无最终内容分别给出可理解的错误；已生成文本必须保留。超时必须适合长 Agent 工作流，不沿用短请求默认值。
12. 若最终 Promise 早于已排队 Channel 事件到达，最终快照把相关 Agent 标记为 terminal；前端忽略该 Agent 之后的迟到 delta/step，防止完成后重新变成生成中或重复答案。
13. 日志记录 Agent ID、事件类型和错误，不记录问题全文、回答全文、trace 原文或凭据。

## Markdown 与安全

- Agent 回答使用 `react-markdown` 并禁用原始 HTML。
- 链接使用安全的外部打开属性。
- 复制和再次编辑使用原始 Markdown，而不是渲染后的纯文本。
- trace 摘要在 Rust 端进行凭据脱敏和长度限制；前端仍使用普通文本渲染，不解释 HTML/Markdown。

## 错误与兼容行为

- 检索失败但 Agent 成功：展示 Agent 回答，并在引用区域说明检索失败。
- Agent 失败但检索成功：展示检索资料和该 Agent 的错误卡片。
- 所有选中资源均失败：该轮标记失败，但保留用户消息和所有局部过程。
- 流中断：保留已经收到的回答，标记“回答中断”，允许复制和放回输入框。
- 旧 RAGFlow 返回非流式 JSON：在 EOF 后解析 `{code,data:{data:{content,reference,trace},session_id}}`，发送一次 delta/completed，功能可用但不伪装为逐字流式。
- session 不再有效：该 Agent 显示本轮错误和“下次提问将开始新会话”，保留历史但清除该 Agent 的 session 映射；本轮不静默重试。

## 验收标准

- 用户消息右对齐，Agent/检索回答左对齐，窄窗口不产生横向滚动。
- 用户与 Agent 消息均可复制；编辑会替换并聚焦底部输入框，历史不变。
- Enter 发送，Shift+Enter 换行，中文输入法确认不误发送。
- SSE 增量到达后无需等待命令结束即可显示回答。
- 两个 Agent 并行返回时，各自文本、状态、执行步骤和 session 不串线。
- 执行过程默认折叠，展开后可查看节点状态；模型思考原文、原始内部 JSON和凭据不出现在界面。
- 引用来源仍可折叠、下载，检索与 Agent 任一局部失败不抹掉另一部分成功结果。
- 用户向上滚动阅读时，后续增量不会强制滚到底部。
- 单元测试、Rust 解析测试、TypeScript 检查、生产构建和知识库页面 Playwright 测试全部通过。

## 必测边界

- SSE 多行 `data:`、心跳、`[DONE]`、顶层 session、业务 error 和异常中断。
- `start_to_think` / `end_to_think`、缺失结束标志及 `<think>` 兼容形态均不得泄漏思考原文。
- `node_finished` 与 `component_finished` 生成相同的安全执行步骤。
- 旧 JSON 返回能降级，且有界缓冲不会无限增长。
- 两个 Agent 交错事件不串线；重复 Agent ID 只执行一次。
- 检索失败但 Agent 成功、Agent 失败但检索成功、worker panic 均能保留局部结果。
- 最终快照不会重复追加 Channel 已发送的 delta，terminal 后迟到事件被忽略。
- 后续提问按 Agent 携带各自 session；session 失效后只清除对应 Agent 映射。
- 编辑只回填输入框，不改变历史或 session；复制使用原始 Markdown。
- Enter 发送、Shift+Enter 换行、IME 确认不误发。
- 用户向上滚动时不被增量强制拉到底部。
