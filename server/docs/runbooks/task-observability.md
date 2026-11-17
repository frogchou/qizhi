# 任务活动、实时监控与运行日志

本手册用于排查任务无反馈、智能体回调异常、规划失败和调度失败等问题。它不要求读取任何密钥文件，也不应在工单、截图或聊天中粘贴管理员令牌、RAGFlow 密钥或完整敏感输入。

## 三层可观测性

1. 控制台活动时间线：每个任务的接收、规划、调度、智能体运行、结果回调和验收都写入 `task_activity_events`，并通过 SSE 推送给控制台。
2. 任务工作目录：`/home/middleground/tasks/<taskId>/` 保存任务状态、会话、计划、智能体产物与诊断文件，是任务可恢复的依据。
3. systemd 运行日志：控制面以一行 JSON 记录关键动作，可按任务 ID、节点 ID 或实例 ID 追溯。Node Manager 的服务日志用于检查实例进程的拉起与停止。

## 控制台实时连接

控制台先经带管理员登录态的接口申请一次性、任务范围固定的 SSE 票据；浏览器再用该票据连接事件流。票据只可使用一次、默认 60 秒过期，且不写入日志或任务目录。浏览器断线后会重新申请票据并用最后活动编号补发遗漏事件。

如果页面显示“重连中”超过 15 秒，先确认控制面服务正常，再按下面的步骤查看该任务的活动和服务日志。

## 用任务 ID 排查

将 `<taskId>` 替换为任务详情页显示的完整任务编号。

查看控制面是否正常运行：

```bash
systemctl status mg-control-plane.service --no-pager
```

查看该任务的结构化日志（最近一小时）：

```bash
journalctl -u mg-control-plane.service --since '1 hour ago' --no-pager | grep '"taskId":"<taskId>"'
```

查看 Node Manager 是否成功拉起或停止实例：

```bash
journalctl -u mg-node-manager.service --since '1 hour ago' --no-pager
```

查看数据库中按时间写入的任务活动：

```bash
docker exec middleground-postgres psql -U middleground -d middleground -P pager=off -c "SELECT id, kind, state, message, source, occurred_at FROM task_activity_events WHERE task_id = '<taskId>' ORDER BY id;"
```

查看任务持久化状态和当前计划版本：

```bash
docker exec middleground-postgres psql -U middleground -d middleground -P pager=off -c "SELECT id, state, current_plan_version, updated_at FROM tasks WHERE id = '<taskId>';"
```

## 常见状态与处理

| 控制台状态 | 应有的后续活动 | 排查重点 |
| --- | --- | --- |
| 分析中 | `planning_started`，随后为 `planning_completed` 或 `planning_failed` | 控制面日志中的 `task_orchestration`；任务目录中的计划与诊断 |
| 编排中 | `scheduling_started`，随后为 `agent_started` 或调度失败 | 可用智能体版本是否已审核为就绪；Node Manager 日志 |
| 智能体工作中 | 一个或多个 `agent_event`，最终 `agent_result` | 实例 ID、租约、智能体目录中的运行产物 |
| 验收中 | `task_accepted` 或失败/待人工验收活动 | 质量管理智能体的回调和验收意见 |

重新启动控制面后，尚未生成计划的 `received` 或 `planning` 任务会被恢复队列重新排入；已领取但租约过期的智能体尝试会按既有恢复规则处理。恢复不绕过智能体审核，也不会自行执行未审核智能体的自检。

## 升级后检查

1. 确认 `mg-control-plane.service` 为 `active`。
2. 打开控制台，检查待审批智能体清单是否出现新发现的智能体版本。
3. 新建一个普通任务，确认时间线先出现“需求已接收”和“中台开始意图分析”。
4. 刷新页面或短暂断网后恢复网络，确认活动时间线仍能补齐而不丢失。
5. 若异常，使用本手册的任务 ID 查询方式收集最小必要日志；日志中不得包含任何凭据。

## 测试数据库隔离（强制）

控制面端到端测试会重建数据库，因此必须显式提供独立的 `TEST_DATABASE_URL`，并且该 URL 不得指向生产数据库 `middleground`。测试守卫会在变量缺失或误指向生产库时立即失败。

在 219 服务器上，推荐为测试单独创建 `middleground_test`；运行测试前仅在当前命令的环境中设置其连接地址。不要把测试连接地址写入控制面服务的环境文件，也不要在生产数据库上运行任何带 `dropDatabase()` 的测试。
