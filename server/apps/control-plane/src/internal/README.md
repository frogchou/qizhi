# 智能体实例回调接口

这些接口由中台内部启动的智能体实例调用，不面向管理员浏览器。实例身份不是固定账号，而是每次调度产生的短期租约。

## 生命周期事件

`POST /internal/v1/instances/:instanceId/events` 接收 Agent Protocol v1 事件。中台仅接受实例 ID、租约令牌和尚未过期的 leased 尝试三者匹配的事件；`(instance_id, sequence)` 唯一，重复序号返回冲突。每个已接受事件都会刷新 `last_heartbeat_at` 和租约有效期，checkpoint 同时写入 `task_checkpoints`。

事件类型包括 `started`、`progress`、`checkpoint`、`completed`、`failed`、`heartbeat` 和 `output`。其中 `heartbeat` 供中台判断进程是否仍存活；Codex 型心跳还可携带 `runtime: "codex"`、运行时长、输出状态和最近输出时长，供中台投影为可读的运行监督信息。`output` 用于受限长度的 stdout/stderr 片段（例如 Codex 运行时输出）。中台把每一个已接受的协议事件持久化到 `task_events`，同时投影为一条经过敏感字段脱敏的任务活动，因此会通过既有 SSE 连接实时到达控制台。

协议事件是“智能体自身的动作账本”。中台与节点管理服务的动作（如请求启动、启动单元被接受、心跳丢失、停止和重试）写入同一任务的 `task_activity_events`，作为“统一执行事件账本”。两类记录均以任务 ID 关联，重连后可从数据库回放。

## 最终结果

`POST /internal/v1/instances/:instanceId/result` 接收：

```json
{ "leaseToken": "本次尝试租约", "result": { "protocolVersion": "v1" } }
```

中台检查协议 Schema、租约、任务与节点身份；每个工件必须是节点工作目录内的相对路径，且 SHA-256 与实际文件相符。只有检查通过的结果才会写入 `nodes/<node-key>/result.json`、更新节点/尝试状态并触发下游调度。重复或迟到的结果不会再次推进任务。
