# 任务私有资料：上传、冻结与智能体授权

本模块让一个需求信号附带一个或多个文件。资料默认只属于当前任务；不会自动写入 RAGFlow，也不会共享到其他任务、会话或智能体。

## 实际运行链路

```text
浏览器 / curl
  → POST /v1/task-inputs/uploads（流式暂存、SHA-256）
  → POST /v1/tasks { goal, acceptanceMode, inputIds }
  → 中台复制并校验到 tasks/<task-id>/inputs/（冻结快照）
  → Codex 规划器读取资料清单，不读取文件正文
  → TaskPlan.taskInputBindings 明确授权给一个节点
  → 调度器复制到 nodes/<node>/input/task-inputs/
  → 智能体只从节点工作目录读取已授权副本
```

没有 `taskInputBindings` 的节点看不到该资料；未经任务冻结的暂存文件不会交给智能体。上游智能体产物的 `inputBindings` 仍是另一套机制，不能代替用户资料授权。

## 接口

所有接口需要当前管理员令牌。令牌只应存在于终端环境变量或浏览器会话中，不能写进命令历史、代码、任务资料或日志。

先上传每个文件，服务返回短暂的 `upload.id`：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MG_ADMIN_TOKEN" \
  -F "file=@./qizhi-brief.txt" \
  http://middleground.example.invalid:3010/v1/task-inputs/uploads
```

再用所有上传 ID 创建任务：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MG_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "goal":"依据附件和企业知识库制作栖知产品介绍 PPT",
    "acceptanceMode":"human_review",
    "inputIds":["<upload-id-1>","<upload-id-2>"]
  }' \
  http://middleground.example.invalid:3010/v1/tasks
```

`GET /v1/tasks/:taskId` 的 `inputs` 只返回安全元数据。使用 `GET /v1/tasks/:taskId/inputs/:inputId/download` 下载已冻结副本；接口不返回服务器绝对路径或暂存路径。

## 目录与数据库

- 上传暂存：`/home/middleground/data/uploads/<upload-id>/blob`。默认 24 小时有效；冻结后不再是智能体可读来源。
- 任务快照：`/home/middleground/data/workspaces/<task-id>/inputs/<input-id>/original/<filename>`。
- 节点副本：`.../nodes/<node-key>/input/task-inputs/<input-id>-<filename>`。

PostgreSQL 表：

| 表 | 关键字段 | 责任 |
| --- | --- | --- |
| `task_input_uploads` | `owner_subject`, `original_filename`, `media_type`, `size_bytes`, `sha256`, `storage_key`, `state`, `expires_at` | 记录未冻结的短暂上传；`storage_key` 不返回客户端。 |
| `task_inputs` | `task_id`, `source_type`, `display_name`, `workspace_relative_path`, `source_ref`, `provenance` | 记录任务不可变资料快照。路径只能相对该任务根目录。 |
| `task_input_audits` | `task_id`, `task_input_id`, `upload_id`, `action`, `actor_subject`, `detail` | 追加记录上传、冻结、节点授权和下载。 |

当前 `source_type` 为 `uploaded_file`。数据库已预留 `ragflow_document`、`ragflow_chunk`、`agent_artifact` 与 `qizhi_local_file`，但这些来源尚未启用。

## 限制与安全行为

- 默认单文件 100 MiB、每任务 25 个文件、每任务总计 500 MiB；可用 `MG_TASK_INPUT_MAX_FILE_BYTES`、`MG_TASK_INPUT_MAX_COUNT` 和 `MG_TASK_INPUT_MAX_TOTAL_BYTES` 调整。
- 上传流式写盘并计算 SHA-256；空文件、目录穿越文件名、超限文件、过期 ID、已消费 ID 和重复 ID 都会被拒绝。
- 创建任务时再次校验暂存文件大小与哈希，然后复制为快照；快照校验失败则整个任务创建失败，不会开始规划。
- 下载读取快照并再次验证大小与哈希。SSE 和控制台只显示数量、名称和摘要，不显示正文、绝对路径、令牌或密钥。
- 当前管理员主体固定为 `administrator`；表中的 `owner_subject` 是后续企业身份体系的扩展点。

## 规划与智能体契约

Codex 收到的资料清单只包含：`id`、显示名、来源类型、MIME 类型、字节数和 SHA-256。若某节点确实需要资料，计划中必须写：

```json
{
  "taskInputBindings": [
    {
      "target": "referenceMaterials",
      "inputId": "<task-input-id>",
      "format": "task_input_paths"
    }
  ]
}
```

编译器校验 `inputId` 属于当前任务且 `target` 是该智能体输入中的数组字段。调度器在启动节点前将副本的**节点相对路径**追加到该字段，并在 `TaskEnvelope.taskInputs` 写入同一份元数据。智能体不能从信封获得上传暂存路径，也不应猜测任务外路径。

## 控制台操作

在“输入需求信号”下点击“附加本任务资料”，可一次选择多个文件。列表允许移除；点击“提交需求”后控制台依次上传文件，全部成功才会创建并冻结任务。任务详情的“任务资料”卡片提供冻结副本下载入口。

任务时间线中的 `task_inputs_frozen` 表示资料已成为任务快照，`task_inputs_bound` 表示已显式授予某一个智能体节点。前者不代表任何智能体都能读取，后者才是实际最小权限授权。

## 后续接入边界

RAGFlow 文件/片段和栖知本地资料将复用同一 `task_inputs` 输出结构和 `inputIds` 创建任务协议。栖知不能将客户端绝对路径传给中台；应上传字节快照或提供经服务端验证的知识库选择引用。本模块不修改栖知，也不自动将上传资料发布到知识库。
