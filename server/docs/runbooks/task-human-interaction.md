# 暂停任务并获取用户输入

当任务详情显示“等待你的输入”时，它没有卡住：中台已持久化问题、活动时间线和任务目录状态，并且不会保留 Codex 或智能体进程等待用户。

## 管理员操作

1. 在控制台打开任务，查看问题来源、标题、提示和可选字段。
2. 填写回答并提交。若需文件，先通过任务资料上传接口获得上传 ID，再在回答请求中作为 `inputIds` 提交。
3. 页面会通过 SSE 显示“已收到用户回答”和“已根据用户回答恢复节点”。静态问题会放行下游节点；智能体问题会创建新的尝试编号。

接口示例（省略令牌）：

```text
POST /v1/tasks/<taskId>/interactions/<interactionId>/respond
Idempotency-Key: answer-20261112-01
{ "response": { "decision": "confirm" }, "message": "面向客户决策者", "inputIds": ["<upload-id>"] }
```

重复使用同一个幂等键是安全的；不同回答在该问题已恢复后会收到冲突。可用 `POST .../cancel` 明确取消等待任务。

## 排障与安全

- 检查 `task_interactions`、`task_interaction_messages` 和任务目录 `interactions/`，不要从浏览器、会话或日志中读取令牌。
- 智能体产生的检查点必须是其节点工作目录内的普通文件且 SHA-256 匹配；中台封存副本后才接受暂停。
- 旧实例在让出后不再持有有效租约；任何迟到的事件或结果都会被拒绝。
- 服务重启只恢复过期租约或尚未规划的任务，绝不会自动回答或恢复 `awaiting_user_input`。
