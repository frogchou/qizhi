# 任务产物归档

智能体结果中的工件必须先通过协议层的相对路径、常规文件和 SHA-256 校验。控制面随后再以同一哈希复核，将文件复制到任务目录 `artifacts/nodes/<node-id>/revision-<n>/` 并写入 `task_artifacts`。

每个节点输出使用独立递增版本；后续重试或返工不会覆盖既有版本。`task_attempts.result` 保留智能体每一次已接受结果，`task_artifacts` 保存可查询的归档索引。下载接口只能按该索引读取归档文件，不能以用户输入拼接节点或服务器文件路径。

## 管理员下载接口

- `GET /v1/tasks/:taskId` 返回工件索引元数据，但绝不返回 `storage_path` 或服务器绝对路径。
- `GET /v1/tasks/:taskId/artifacts/:artifactId` 需要管理员 Bearer 认证，按工件 ID 和任务 ID 双重匹配读取已归档文件。

下载响应始终是附件，带受控媒体类型、文件名和 `X-Content-Type-Options: nosniff`。下载前再次确认真实文件位于该任务的 `artifacts/` 目录，并复核归档 SHA-256；已移除、篡改或跨任务引用均被拒绝。

## `task_artifacts` 字段

| 字段 | 含义 |
| --- | --- |
| `id` | 工件的不可猜测标识 |
| `task_id`、`task_node_id`、`task_attempt_id` | 任务、节点和产生它的精确尝试 |
| `revision` | 节点输出版本号 |
| `original_path` | 智能体报告的节点内相对路径 |
| `storage_path` | 任务根目录内的不可覆盖归档路径 |
| `file_name`、`media_type` | 控制台展示和安全下载响应信息 |
| `sha256`、`size_bytes` | 完整性校验和大小 |
| `created_at` | 归档时间 |
