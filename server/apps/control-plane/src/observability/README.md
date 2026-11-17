# 任务活动与实时监控

`TaskActivityService` 将任务接收、规划、调度、智能体回调和验收过程写入只追加的 `task_activity_events`。每条记录包含稳定事件号、任务 ID、阶段状态、面向用户的中文说明、脱敏细节、来源和时间。

`TaskActivityPublisher` 是当前单控制面进程内的发布器。SSE 客户端实时订阅该发布器；重连或控制面重启时，客户端使用事件号从 PostgreSQL 的活动表补发，因此发布器不承担持久化职责。

## SSE 接口

1. 已登录控制台先调用 `POST /v1/tasks/:taskId/events/stream-ticket`。此请求使用管理员 Bearer 令牌，返回有效期 60 秒、任务范围固定且只能使用一次的随机票据。
2. 浏览器使用 `GET /v1/tasks/:taskId/events/stream?ticket=...` 创建 `EventSource`。SSE 不接收管理员令牌，票据使用后立即失效。
3. 连接先收到 `snapshot`，再按递增的 SSE `id` 收到 `activity`。`Last-Event-ID` 使重连只补发遗漏活动；建立订阅与历史查询之间的事件在内存缓冲区去重，避免丢失或重复。

票据不得写入应用日志、任务目录、活动事件或界面调试 JSON。前端在重连前重新申请票据。

写入前会递归删除名称包含 `apiKey`、`authorization`、`password`、`secret`、`token` 或 `cookie` 的字段值，并限制字符串、数组和嵌套层数。不要将原始管理员令牌、RAGFlow 密钥、完整模型提示词或思维过程传给该服务。

## 结构化运行日志

`OperationalLogger` 将控制面关键动作以单行 JSON 写入标准输出，systemd 会将其收集到 `mg-control-plane.service` 的 journald 日志。日志使用 `component`、`event`、`taskId`、`nodeId`、`instanceId` 等字段关联一次任务在规划、调度、智能体回调和验收中的各个步骤；内容同样经过脱敏和长度限制。

活动事件是面向控制台的业务时间线，运行日志是故障排查证据；两者互补，均不应包含凭据或完整敏感输入。具体查询方式见 `docs/runbooks/task-observability.md`。
