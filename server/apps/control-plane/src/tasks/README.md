# 任务与流程监控

`TaskService` 负责把需求信号持久化为任务、计划、节点和尝试记录。它只完成工作目录、任务行和“需求已接收”活动事件的原子前置工作，随后立即返回任务 ID；不会在 HTTP 请求中等待 Codex、知识库或智能体。

`TaskOrchestrationService` 是任务 ID 去重的后台入口。它按“开始规划 → 编译执行图 → 开始调度”运行，所有阶段写入持久活动流；无论故障发生在规划器内部还是其调用之前，都会把任务从 `planning` 置为可见的 `planning_failed`（或后续阶段的 `failed`），并保存可读的会话和状态快照。服务启动时 `TaskRecoveryService` 还会重新投递没有执行图的 `received`/`planning` 任务，避免服务重启留下永远卡住的“分析中”。

控制台通过以下只读接口获取真实状态：

- `GET /v1/tasks`：最近任务列表。
- `GET /v1/tasks/:taskId`：任务、节点、尝试、事件和由 `task-monitor.ts` 投影的五段流程。

流程投影固定展示需求接收、中台意图分析、智能体编排、智能体工作和结果验收。`task-monitor.ts` 聚合全部持久化节点、尝试和事件：编排阶段说明节点数及能力集合，执行阶段说明已完成、执行中和等待中的节点数，并保留每个生命周期事件。它不以第一个节点替代整张执行图。

真正的意图分析与通用编排由 `planning/` 完成：本机 Codex 只能从审批后处于 `ready` 的能力目录中生成结构化计划，随后必须经过协议编译器校验才会调度。因此流程投影是对已运行编排的可读解释，而不是 UI 侧的静态模拟。

## 任务目录与会话

`TaskWorkspaceService` 在工作区根目录下为每个任务创建独立目录，其中包含 `plans/`、`session/`、`nodes/`、`artifacts/` 和 `quality/`。`task.json` 保存需求事实，`state.json` 保存可原子替换的最新快照，`session/conversation.jsonl` 只追加中台与人工决定。目录中的状态和会话不得写入任何令牌、密码、密钥或环境变量。

## 生产装配

中台通过 `AppModule` 的显式工厂装配 `TaskService` 与 `PlanningService`，并显式传入数据库、工作区、会话、规划器和调度器。这样无论 TypeScript 运行器是否保留装饰器类型元数据，HTTP 任务创建与后台编排都会使用同一组已验证依赖，避免出现服务实例中的依赖为 `undefined`。

每个节点使用 `nodes/<node-key>/envelope.json` 保存任务信封；路径必须受任务根目录约束，不能通过绝对路径或 `..` 访问其他任务。

## 调度、结果与恢复

`TaskSchedulerService` 是唯一可以创建智能体尝试记录的模块。它将已经编译的计划写成 `task_nodes`，等待声明的依赖完成，把证据或工件复制到下游节点自己的 `input/` 目录，再通过节点管理服务启动已经审核的版本。中台不会导入或直接调用智能体包的业务函数。

输入绑定的目标必须在静态输入中声明为数组。编译器会在 Schema 校验时填入确定性的占位值，调度器则在上游节点完成后将该占位位置替换为任务目录中的真实证据或工件路径。因此 `quality.define_and_verify.targets: []` 可以安全地由 PPT 的 `presentation.pptx` 工件填充，且质量智能体只会看到自己的任务本地副本。

工件绑定可以显式给出受任务目录约束的相对 `artifactPath`；未给出时，中台只会在上游恰好返回一个工件时自动绑定它。上游返回零个或多个工件时不会猜测文件，而是让节点启动失败并记录可读原因。

经结果回调校验的工件还会被复制至任务根目录 `artifacts/nodes/<node-id>/revision-<n>/`，并由 `task_artifacts` 索引。归档文件不可被后续尝试覆盖；详见 [ARTIFACT_DELIVERY.md](./ARTIFACT_DELIVERY.md)。

运行环境文件位于服务器运行目录而非任务目录，权限为 `0600`；任务目录中的计划、状态和会话不会保存令牌、密码或 API Key。智能体以 `{ leaseToken, result }` 回调结果，中台验证有效租约、任务身份、工件路径及 SHA-256 后才推进节点。

`TaskRecoveryService` 会恢复两类工作：租约已过期且尚未收到结果的尝试，以及尚未产生已编译执行图的 `received`/`planning` 任务。前者的旧尝试标为 `interrupted`，节点回到 `pending` 并获得新的尝试编号；后者交给 `TaskOrchestrationService` 去重后重新规划。已经接受的任务不会重新启动。质量节点失败时任务立即进入 `awaiting_review`，由管理员选择接受当前交付或根据归档 PPT、验收标准和质检意见发起下一轮返工；系统不会隐藏式自动返工。

### 人工交互与恢复

执行图可包含 `human_interaction` 节点；智能体也能以 `needs_user_input` 结果主动提问。两种情况都写入 `task_interactions`、活动流和任务目录 `interactions/<interaction-id>/`，任务状态为 `awaiting_user_input`。这不是阻塞中的 Codex 进程：静态节点不启动下游分支；智能体节点会将原尝试标为 `yielded`、校验并封存检查点，然后退出。

管理员使用 `POST /v1/tasks/:taskId/interactions/:interactionId/respond` 回答，必须携带 `Idempotency-Key`。中台会先原子占用该问题的回答权，再冻结已上传的 `inputIds` 为任务私有资料并复制到交互目录；并发的不同回答不能创建额外资料或触发第二次恢复。中台是唯一恢复者：静态问题只完成该节点，智能体问题则创建新的尝试，并将已封存检查点和经校验的回答放入 `TaskEnvelope.resume`。服务重启绝不自动恢复 `awaiting_user_input` 任务。

### 返工的新鲜产物约束

返工仅把上一版的归档交付物复制到 PPT 节点的 `input/` 目录，归档版本保持不可变。中台在重新调度 PPT 与质量节点前会删除这些节点的可变运行输出，包括 Codex 最终消息、标准输出日志、PPT、PPT 自检报告、质量报告、验收标准、渲染目录和审计目录。Codex 运行时也会在每次调用前删除自己的最终消息哨兵文件。

PPT 智能体在启动时记录现有 PPT 和自检报告的文件指纹；调用结束后，若文件仍是同一份旧文件，或没有生成所需文件，节点必须失败而不能报告成功。这样控制台会显示可诊断的节点失败，而不会把上一轮交付或质量结论误显示为本轮返工结果。

## 运行中监督与自动恢复

`TaskLivenessService` 是进程外的中台监督器，不依赖浏览器 SSE 连接。节点管理服务返回运行单元名称只代表 systemd 接受了启动请求；只有智能体发回第一条 `heartbeat` 才代表智能体代码已真正引导成功。

- 公共运行时会在引导后立即发送心跳，随后每 10 秒发送一次；任何已接受的协议事件同样刷新尝试的 `last_heartbeat_at` 与租约。
- Codex 型智能体在公共心跳之外还会报告其子进程是否已启动、累计执行时长和最近输出新鲜度。内容生成没有隐式总时限；只要实例与 Codex 子进程持续存活，中台会继续等待并通过 SSE 公开该状态。短时规划调用仍可使用独立的显式超时。
- 中台意图分析同样把本机 Codex 的状态持久化为 `planning_codex_status` 活动：规划阶段不配置超时时会持续等待，同时时间线会显示“已运行多久 / 最近输出多久前”。只有显式设置 `MG_CODEX_PLANNER_TIMEOUT_MS` 才为规划增加硬时限。
- 中台每 5 秒扫描一次 `leased` 尝试。20 秒未收到首次心跳，或 45 秒没有后续心跳，会被标记为 `interrupted`，并写入 `agent_liveness_lost` 会话、活动流及结构化服务日志。
- 中台会请求节点管理服务停止失联实例；第一次失联自动重新调度一次。第二次失联不再静默循环，而是把节点标为 `failed`，由调度器把任务转为可见的失败状态。
- 这一策略与质量验收的单次返工独立：前者解决“实例没有活着”，后者解决“交付物质量未通过”。

在调度侧，活动流也区分 `agent_launch_requested` 与 `agent_launch_accepted`；后者仍会提示“等待首次心跳”，不会把“中台已创建 systemd 单元”伪装成“智能体已经运行”。
## 工厂内停止工单

### 工厂输入资料的来源

`POST /v1/task-inputs/uploads` 接收一个名为 `file` 的 multipart 文件。普通上传默认登记为 `uploaded_file`。栖知发送资料筐快照时同时提供 `X-Qizhi-Source-Type`（qizhi_local_file、ragflow_chunk 或 ragflow_document）和 `X-Qizhi-Basket-Id`（条目 UUID）。中台校验这两个字段后存储文件字节及摘要，冻结到工单后在输入清单保留来源。条目标识仅用于追溯，即使稍后清空桌面资料筐，工单仍可读取自己保存的快照。新建任务及人工补充使用的 `inputIds` 均为暂存上传返回的 id。

任务详情在接收、规划、运行或等待处理期间提供「停止工单」。管理员确认后，客户端请求 `POST /v1/tasks/:taskId/stop`。中台先将状态改为 `stopping`、中断该工单的规划和验收、撤销其节点执行，并在节点管理器确认后返回 `cancelled`。停止状态持久化；重复请求可继续未完成的停止操作，已停止的工单返回相同结果。已结束工单返回 409 `task_already_finished`，执行单元尚未确认退出时返回 409 `task_stop_pending`。两种结果均可从工单详情核实。中台进行验收时，执行时间线的 `acceptance_progress` 活动记录当前环节及其运行时长，便于区分检索等待和结果复核。
# 同单人工退回与补充

交付正文、文件与过程附件的统一展示约定见 [DELIVERY_CONTENT.md](./DELIVERY_CONTENT.md)。完整 `output.answer` 优先于执行摘要；历史审阅结果中的详细分析会恢复为可阅读正文。

在 `awaiting_review` 工单上使用 `POST /v1/tasks/:id/review`。原有 accept、rework 和 supplement 的行为继续可用。新决定 revise 表示退回重新制作，amend 表示补充需求。两种决定均在同一工单上使用生产规划器重新编排，完成后交回人工验收。

- 请求头 `Idempotency-Key` 必填，可用 1 到 160 位字母、数字、句点、横线或下划线。网络中断后重试同一内容时沿用它。服务返回原始受理回执，实际进度由工单详情呈现。
- JSON 可包含 `message`（最多 4000 字）、`inputIds`（现有上传接口返回的暂存标识）和 `reviewId`。amend 至少需要文字或一个附件。revise 允许只提交决定。详情的 `currentReviewId` 非空时必须原样带回；历史待审工单没有对应验收轮次时省略此字段。
- 成功返回 `{taskId,state:"planning",decision,revisionId,revisionNumber,reviewId,inputIds}`。此时 inputIds 已是冻结后的任务资料标识。附件保留原来源和校验摘要，规划必须把冻结资料显式绑定给工作节点。
- 状态或验收轮次已变化时返回 HTTP 409 和 `stale_review`。同一幂等键改用于其他消息、文件或决定时返回 409 和 `idempotency_conflict`。无效的修订请求返回 400；资料过期、已消费及超出任务限额时返回相应附件错误，事务回滚后工单仍可处理。

修订与消费附件在同一数据库事务中提交。第一轮即使只有直接文字答复、没有验收记录，也能进入新计划。新轮工作目录按修订号隔离，只调度当前计划的节点，归档制品仍沿用原工单下载地址。详情中 revisions、plans、acceptanceRounds、nodes 和 artifacts 保留历次记录。活动账本记录 human_revision_requested 或 human_amendment_requested。停止操作继续作用于原工单，服务重启后从持久化的 planning 状态恢复，规划或验收异常通过已有工单状态和活动报告。

退回或补充时，控制面从上一计划每个节点、每个交付路径选择最新归档版本，验证工单归属、归档目录和 SHA-256，将其登记为 agent_artifact 私有资料。接口返回的 previousDelivery.artifacts 关联原制品 ID、校验值和可绑定的 inputId。规划器可以把这些资料显式授权给支持相应格式的工作节点；调度时再次校验节点本地拷贝。用户本轮上传的资料仍需逐一绑定。纯文本上版答复同时从节点 output.text、answer、summary 或 message 保留，供兼容的旧文字能力生成修订简报。历史资料引用不会挤占用户上传文件配额。
