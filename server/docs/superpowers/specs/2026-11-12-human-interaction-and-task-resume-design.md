# 通用人机交互与任务恢复设计

**状态：待确认**<br>
**日期：2026-11-12**<br>
**范围：中台、智能体协议、控制台、任务目录与数据库**

## 1. 背景与结论

平台当前具有两种人工动作：智能体版本审核，以及质量验收阶段的“确认交付 / 根据意见返工”。它们不能满足智能体在执行过程中向用户追问、请求确认或收集结构化资料的需求。

检查现状后确认，通用链路尚未打通：

- 协议定义了 `approval` 计划节点，但调度器只把 `agent_call` 物化为 `task_nodes`，因此 `approval` 节点没有运行状态、没有用户问题，也不能解除下游依赖。
- `approval_requests` 是早期预留表，当前没有服务、控制器或控制台使用它；它也缺少提问者、问题、回答、结构、上下文、恢复点和版本字段。
- `POST /v1/tasks/:taskId/review` 只接受最终验收的 `accept` 或 `rework`，不能提交补充信息或确认某一步计划。
- 任务状态、恢复服务、流程投影和控制台均不认识“等待用户输入”。服务重启后无法以正确语义保留这种暂停。
- SSE 活动流、`task_sessions`、任务目录和任务私有资料已可复用，是实现本设计的基础，而不是需要另建一套通道。

本设计采用**计划原生的人机交互节点 + 智能体可让出执行权的交互请求**。用户回答时，不让运行时或 Codex 进程闲置等待；中台持久化暂停点并结束本次运行。收到回答后，中台从同一任务和同一节点的恢复点重新调度。这使任务能跨浏览器断开、服务重启和长时间等待安全恢复。

本设计是后续“创造智能体的智能体”的前置能力；本次不实现该智能体。

## 2. 目标与非目标

### 目标

1. 中台计划可在任意依赖位置请求用户**确认、澄清或填写结构化表单**。
2. 智能体可在运行中声明“还需要用户信息”，带着检查点安全让出执行权。
3. 任务暂停期间，不启动任何依赖该交互结果的节点；任务目录、会话、输入资料和已完成工件保持不变。
4. 用户通过控制台或 API 提交文本、结构化字段、确认决定，以及引用当前任务私有资料的补充材料。
5. 回答经过模式校验、审计和幂等保护后写入任务会话；任务从准确的等待节点恢复。
6. 控制台和 SSE 实时展现“谁在等待什么、已等待多久、用户何时回答、恢复到哪里”。
7. 中台重启后保留等待状态，且**绝不**在没有回答的情况下自动继续任务。

### 非目标

- 本期不开发“创造智能体的智能体”；它只消费本设计提供的多轮交互能力。
- 本期不做多租户、多人投票、外部 IM 审批、LDAP 身份体系或知识库写入审批。
- 本期不保持暂停时的进程内存、Codex 子进程或 shell 会话；智能体必须从任务目录检查点重新进入。
- 本期不取代现有的智能体版本审核，也不改变质量验收的业务含义；二者会迁移到统一交互基础设施，但仍保留各自决策规则。

## 3. 方案选择

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 通用人机交互节点（本设计） | 采用 | 计划和智能体均可产生交互；能建模依赖、审计、恢复和多轮对话。 |
| 任务留言箱 | 不采用 | 无法表达哪个节点在等待、答案结构、下游依赖和精确恢复点。 |
| 扩展最终验收接口 | 不采用 | 只能处理接受/返工，无法支持智能体创造者所需的自适应需求澄清。 |

## 4. 核心概念与状态机

### 4.1 两类交互来源

1. **计划交互节点**：中台规划器在可预测的关键点加入。例如“先确认交付语言”“缺少目标受众，请补充”。它与普通节点一样出现在 DAG 中。
2. **智能体运行时交互请求**：智能体已开始工作后，才发现信息不足或需要用户做选择。例如资料收集智能体发现关键词歧义，或智能体创造者需要追问权限范围。智能体报告可恢复检查点并返回 `needs_user_input`，而不是假装成功或失败。

两者都落到同一组 `task_interactions` / `task_interaction_messages` 记录、同一 SSE 活动流、同一控制台回答界面和同一恢复机制。

### 4.2 任务与节点状态

新增任务状态 `awaiting_user_input`；现有 `awaiting_review` 仍专用于最终人工验收。

```text
received → planning → planned → running
                             │
                             ├─ 计划交互节点 / 智能体 needs_user_input
                             ▼
                      awaiting_user_input
                             │
              用户回答并通过校验 / 管理员确认
                             ▼
                  planned（等待调度）→ running
                             │
                  所有节点完成且需要验收
                             ▼
                      awaiting_review → accepted
```

节点状态新增 `awaiting_user_input`。节点从此状态恢复时，进入 `pending`，由调度器创建新的尝试编号；旧尝试保留为 `yielded`，而不是被错误标为失败或中断。

```text
pending → leased → running → succeeded
                       │
                       ├─ needs_user_input → awaiting_user_input
                       │                         │
                       │                         └─ 已回答 → pending（新尝试）
                       └─ failed / interrupted
```

**暂停不是阻塞。** 当智能体请求用户输入时，实例必须写入检查点并正常报告。中台撤销该尝试的继续资格、停止该实例或允许其自然退出，随后才标记任务为 `awaiting_user_input`。等待几小时或几天不消耗 Codex、节点管理服务或智能体进程。

### 4.3 并发规则

- 一个任务同一时刻最多允许一个 `pending` 交互；如果多个并行节点同时需要输入，中台将任务置为等待状态，但保留多个有序问题，控制台逐项显示。
- 只有不依赖等待节点且在计划中允许并行的节点可继续运行。默认规划器应避免在用户输入不确定时启动会被其答案影响的昂贵节点。
- 某个问题得到回答，仅解除该问题所对应节点；调度器按 DAG 依赖重新判断可启动节点，绝不“整任务盲目重跑”。
- 回答、取消和过期采用条件更新：仅 `pending` 交互可被首次回答，重复提交返回已处理状态而不创建第二次恢复尝试。

## 5. 协议设计

### 5.1 计划节点

在协议中新增 `human_interaction`，保留旧 `approval` 作为兼容别名，并在编译时归一为确认型交互。

```json
{
  "key": "confirm_delivery_style",
  "type": "human_interaction",
  "dependsOn": ["retrieve_brand_material"],
  "interaction": {
    "kind": "confirmation",
    "title": "确认 PPT 表达风格",
    "prompt": "已找到两套品牌资料。请确认采用正式商务风格，或补充目标受众。",
    "responseSchema": {
      "type": "object",
      "required": ["decision"],
      "properties": {
        "decision": { "type": "string", "enum": ["confirm", "revise"] },
        "note": { "type": "string", "maxLength": 4000 }
      },
      "additionalProperties": false
    },
    "responseTarget": "task.session.delivery_style"
  }
}
```

规则：

- `kind` 仅允许 `confirmation`、`clarification`、`form`。
- `title`、`prompt`、`responseSchema` 是冻结计划的一部分，不能由浏览器改写。
- `responseSchema` 使用受限 JSON Schema 子集（对象、数组、字符串、数字、布尔、枚举、必填、长度/数量边界）；服务器用同一校验器验证 API 输入。
- `responseTarget` 是逻辑键，不是文件路径。它指示回答进入任务会话/恢复上下文的哪个命名空间，不能写入环境变量或任意本地路径。

### 5.2 智能体结果扩展

`AgentResult` 新增互斥状态 `needs_user_input`：

```json
{
  "status": "needs_user_input",
  "summary": "无法确认目标运行时是否允许访问互联网。",
  "interaction": {
    "kind": "clarification",
    "title": "确认网络访问范围",
    "prompt": "新智能体是否需要访问公网？如需要，请说明域名范围与用途。",
    "responseSchema": {
      "type": "object",
      "required": ["internetAccess"],
      "properties": {
        "internetAccess": { "type": "boolean" },
        "allowedDomains": { "type": "array", "items": { "type": "string" }, "maxItems": 30 }
      },
      "additionalProperties": false
    }
  },
  "checkpoint": {
    "schemaVersion": 1,
    "resumeKey": "requirements-round-3",
    "workspaceRelativePath": "nodes/create_agent/checkpoints/requirements-round-3.json",
    "sha256": "…"
  }
}
```

中台必须验证：回调租约、交互模式、检查点相对路径、文件 SHA-256 和路径是否位于该任务节点目录。检查点不得包含令牌、API Key 或绝对主机路径。

再次调度时，`TaskEnvelope` 增加只读的 `resume` 块：

```json
{
  "resume": {
    "fromInteractionId": "…",
    "checkpoint": { "workspaceRelativePath": "…", "sha256": "…" },
    "answers": [{ "interactionId": "…", "response": { "internetAccess": true } }]
  }
}
```

智能体应把检查点与回答视为不可信输入，重新校验后继续；不得根据先前内存假设用户已确认。

### 5.3 事件

复用 `AgentEvent` 和任务活动流，增加以下可读活动类型：

- `human_interaction_requested`
- `human_interaction_waiting`
- `human_interaction_answered`
- `human_interaction_validation_failed`
- `human_interaction_resumed`
- `human_interaction_cancelled`
- `human_interaction_expired`

所有事件包含 `taskId`、交互 ID、节点键、来源、当前状态和无敏感信息的摘要。用户回答正文只存在受保护的交互记录、任务会话和任务目录，不在公开 SSE 摘要、普通服务日志或错误消息中完整回显。

## 6. 数据模型与任务目录

### 6.1 数据库

新增两张表；旧 `approval_requests` 在迁移后只作为历史兼容读模型，新的业务流程不再写入它。

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `task_interactions` | `id`, `task_id`, `task_plan_id`, `task_node_id`, `plan_node_key`, `source`, `kind`, `title`, `prompt`, `response_schema`, `response_target`, `state`, `checkpoint`, `requested_by_attempt_id`, `answered_by_subject`, `answered_at`, `expires_at` | 一次待答的人机交互及其恢复锚点。 |
| `task_interaction_messages` | `id`, `interaction_id`, `sequence`, `role`, `content`, `structured_content`, `attachments`, `created_at` | 只追加的多轮对话事实；角色为 `control_plane`、`agent`、`user`、`system`。 |

`task_interactions.state`：`pending | answered | resumed | cancelled | expired`。数据库唯一约束保证一个节点同一恢复轮次只能有一个待答交互；`task_interaction_messages(interaction_id, sequence)` 唯一，防止并发回答乱序。

`task_attempts.state` 新增 `yielded`。`task_nodes.state` 新增 `awaiting_user_input`。`tasks.state` 新增 `awaiting_user_input`。所有枚举/约束、实体、测试夹具和监控投影必须在同一迁移中演进。

### 6.2 任务目录

任务目录新增以下只追加或不可变文件：

```text
<task>/
  interactions/
    <interaction-id>/
      request.json
      messages.jsonl
      answer.json                 # 回答后生成，权限受任务目录约束
      attachments/                # 回答所引用的私有资料副本
  nodes/<node-key>/
    checkpoints/<resume-key>.json
```

`task.json` 只记录资料事实；`state.json` 投影当前的等待问题 ID、节点和可读摘要；`session/conversation.jsonl` 追加交互请求、用户回答、恢复决定的概要。目录内容不能替代数据库条件更新，也不能保存任何服务凭据。

### 6.3 文件补充

用户初次提交任务时已有任务私有资料上传机制。交互回答接口可携带当前任务已冻结资料的 `inputIds`，并允许由已认证管理员先上传、再引用暂存上传 ID。中台把它们复制到 `interactions/<id>/attachments/` 并创建新的任务输入快照/审计记录；智能体只在恢复信封明确授权时读取这些路径。

这样资料默认仅当前任务可见；是否上传到知识库仍是另一个显式、可审计的未来动作，不能由回答接口隐式执行。

## 7. 服务与调度行为

### 7.1 编译和物化

当前 `task_nodes` 只代表 `agent_call`，不足以严格跟踪交互节点。实施时将它演进为“所有可执行计划节点的运行记录”，或新增等价的 `task_runtime_nodes` 并一次性迁移读取路径。推荐前者：每个编译计划节点都有一条运行记录及状态；只有 `agent_call` 具备智能体版本、尝试和租约字段。

调度器按照下列顺序运行：

1. 读取冻结计划和所有运行节点，在事务中找出依赖均已完成的 `pending` 节点。
2. 对 `human_interaction` 节点创建 `task_interactions`，将节点和任务置为 `awaiting_user_input`，写活动并停止向下调度。
3. 对 `agent_call` 节点按既有租约流程启动实例。
4. 当智能体回报 `needs_user_input`，原子写检查点、标记尝试 `yielded`、创建交互、标记节点/任务等待并写活动。
5. 当用户回答时，校验模式并原子标记交互 `answered`；相应计划交互节点直接完成，或相应智能体节点转为 `pending`，随后投递调度器。
6. 恢复调度创建新的尝试编号，向该节点的 `TaskEnvelope.resume` 传递经验证的检查点与回答。其他已成功节点不重跑。

### 7.2 最终验收与返工的兼容

现有 `awaiting_review` 仍是“工作完成后是否接收交付物”的终态等待。它不等同于 `awaiting_user_input`：

- 前者的选择是业务验收决定，接受或显式发起返工。
- 后者是 DAG 运行过程中缺少信息，回答后自动恢复确定的节点。

后续可逐步把质量验收 UI 复用为交互组件，但不得把两种状态合并，否则会造成调度器把尚未验收的成果误当作可继续执行的输入。

### 7.3 失败、取消与恢复

- 服务启动恢复扫描忽略 `awaiting_user_input`，不自动启动实例；只重建 SSE 订阅和可读投影。
- 如果回答提交时任务、节点或交互已取消/过期，返回冲突状态并保持原始证据，不可隐式复活任务。
- 交互可有可选 `expires_at`；到期由中台明确标为 `expired` 并把任务置为可读失败/待管理员处理，绝不猜测默认答案。
- 人工取消交互会令相应节点和任务进入 `cancelled` 或 `failed`，取决于计划的取消策略；第一期默认整个任务 `cancelled`，避免在信息不足时继续产出。
- 智能体在 `yielded` 后仍发送普通完成回调、心跳或事件时，中台拒绝并审计，不得覆盖新的尝试。

## 8. API、SSE 与控制台

### 8.1 API

| 接口 | 行为 |
| --- | --- |
| `GET /v1/tasks/:taskId/interactions` | 返回任务交互历史和当前待答项；回答正文按管理员权限返回。 |
| `GET /v1/tasks/:taskId/interactions/:interactionId` | 返回一项问题、受限响应模式、消息与已授权附件元数据。 |
| `POST /v1/tasks/:taskId/interactions/:interactionId/respond` | 提交 `{ response, message?, inputIds? }`；校验模式、冻结附件、写审计并投递恢复。 |
| `POST /v1/tasks/:taskId/interactions/:interactionId/cancel` | 管理员取消待答问题及其任务。 |
| `GET /v1/tasks/:taskId/events` / SSE | 继续使用现有活动流，增加交互事件。 |

所有写接口沿用当前固定管理员令牌。`respond` 支持 `Idempotency-Key`；重复请求必须返回同一已接受结果而不触发第二次恢复。所有接口禁止接受工作区绝对路径、租约令牌、实例 ID 覆盖或任意文件路径。

### 8.2 控制台

任务详情增加“等待你的输入”卡片，置于执行流程与节点详情之前：

- 显示提出者（中台 / 智能体名）、节点、问题、等待时长、状态与受限回答表单。
- `confirmation` 显示确认/拒绝与说明；`clarification` 显示文本与可选资料；`form` 由受限 Schema 渲染字段。
- 已回答问题显示摘要、回答时间、恢复节点与新尝试编号；敏感字段可在后续权限系统接入后掩码。
- 活动时间线实时显示请求、回答、校验失败、恢复与智能体新心跳。控制台断线重连后通过详情 API 补齐，不依赖浏览器一直在线。
- 原始 JSON 继续仅在开发者调试区展示；用户主界面显示可读语言而不是协议字段。

流程投影把“智能体工作”阶段扩展为“执行中 / 等待用户信息 / 已恢复”；若等待发生在规划期，则“中台意图分析”明确显示相应问题，而不是错误标为规划失败。

## 9. 安全、审计与权限

- 第一阶段只有管理员主体可查看和回答任务交互；API 仍验证固定管理令牌。
- 问题、回答、结构化字段、附件绑定、恢复决定、取消和模式校验失败都写 `task_interaction_messages`、`task_sessions`、`task_activity_events` 与 `audit_events` 的相应摘要。
- 用户输入是业务数据，不应完整写入普通运行日志或 SSE 摘要；日志仅记录交互 ID、字段名集合、大小、校验结果和恢复结果。
- 回答附件只属于当前任务；中台以任务目录内相对路径传递，智能体必须在信封授权范围内访问。
- 交互 Schema 限制深度、字段数、数组大小和字符串长度，防止用户输入造成无界数据库/前端负载。
- 规划器、智能体和浏览器都不能自行把回答变成 shell 指令、运行时配置或任意文件路径；业务智能体仍须自行将它视为不可信输入。

## 10. 测试与验收标准

### 自动测试

1. 协议：`human_interaction`、兼容 `approval` 归一化、`needs_user_input`、检查点及 Schema 约束的有效/无效样例。
2. 编译器：交互节点的依赖、唯一终点、无环校验及未知字段拒绝。
3. 调度器：计划交互暂停下游节点；回答后只启动依赖满足的节点。
4. 智能体回调：`needs_user_input` 原子生成交互，旧尝试为 `yielded`；无检查点、越界路径、错误 SHA、重复/过期租约均被拒绝。
5. 回答 API：模式校验、幂等键、并发双提交、非法附件、取消/过期交互以及审计记录。
6. 恢复：服务重启不启动 `awaiting_user_input` 任务；回答后才创建下一次尝试；旧实例后续回调被拒绝。
7. 监控：SSE 和详情投影包含等待时长、问题来源、回答和恢复活动，不暴露回答正文。
8. 回归：现有质量人工验收、返工、新鲜产物、私有资料和节点失联恢复全部继续通过。

### 人工验收场景

使用一个最小测试智能体：首次执行创建 `requirements-round-1` 检查点并询问“智能体是否允许访问公网”；管理员回答并附一份任务私有资料；控制台应立即显示回答已接收、同一节点创建新尝试、智能体从检查点继续，最终交付一个可审计结果。服务重启发生在等待期间时，任务仍显示待回答且不启动新实例。

## 11. 对“创造智能体的智能体”的支撑

该智能体将不是特例，而是一个普通、可恢复的智能体：

1. 首次运行读取需求与可用平台规则，形成需求缺口清单。
2. 通过 `needs_user_input` 提问；每次都把需求模型和问题轮次写为检查点。
3. 用户回答后，中台用 `resume` 信封重新启动该节点；智能体合并历史答案，继续追问或进入设计。
4. 需求充分后，智能体在任务目录生成智能体包、声明文件、测试、文档和待审核交付物。
5. 中台现有发现/审核流程读取该包；未经审核绝不执行新包。

因此它能多轮挖掘需求，但不会绕过智能体注册、审核、能力声明、任务隔离或审计规则。

## 12. 实施边界与迁移顺序

1. 先修改协议和数据库迁移，完成状态与实体的一致性测试。
2. 改造计划编译/运行节点物化与调度器，交付计划交互节点的暂停/恢复。
3. 扩展 `AgentResult`、回调处理和 `TaskEnvelope.resume`，交付运行时交互请求。
4. 实现回答/取消 API、会话/审计、恢复服务与 SSE 活动。
5. 更新控制台、流程投影、运行手册和数据库说明。
6. 运行全量回归、真实部署验证，再开始“创造智能体的智能体”的需求与设计。

任何阶段都不得把等待用户回答实现为长时间占用 Codex 子进程或数据库租约；不得为了演示而自动填写回答或自动恢复任务。
