# 任务私有资料输入：实施计划

**目标：** 让一个需求信号可以安全地附带多个仅对当前任务可见的文件；中台在创建任务时冻结资料快照，向规划器提供资料清单，并由编排结果将资料显式交给需要它的智能体。资料来源、操作记录和交付链路均可审计。

**范围边界：** 本阶段实现本地文件上传、任务冻结、任务资料清单、智能体工作目录物化、控制台与 curl 接口。RAGFlow 已有文件/知识片段选择、栖知本地资料选择及“上传到知识库”作为后续阶段接口预留，不改变栖知代码，也不自动上传资料至知识库。

## 现有事实与设计约束

- 当前 `POST /v1/tasks` 仅接收 `goal` 和 `acceptanceMode`，控制台也只发送这两个字段。
- 当前任务工作目录只承载智能体的上游节点输入和产物，不含用户提交的原始资料。
- 智能体须继续只能从任务工作目录读取本任务物化的资料；不得从 API 传入任意宿主机路径。
- 同一资料在任务开始后不得被原始上传文件替换；返工读取的是已冻结版本，而不是重新上传的同名文件。
- 数据库是可演进的测试环境，但迁移仍须保持可重复执行、可追溯和向前兼容。

## 目标数据模型

新增迁移 `0005-task-inputs.ts`，新增三张表：

1. `task_input_uploads`：任务创建前的短暂上传暂存。
   - `id`、`owner_subject`、`original_filename`、`media_type`、`size_bytes`、`sha256`、`storage_key`、`state`、`created_at`、`expires_at`。
   - 仅 `ready` 状态且未到期的上传可被任务引用；初期主体固定为管理员，但字段为多用户预留。
2. `task_inputs`：已冻结到任务的资料记录。
   - `id`、`task_id`、`source_type`、`display_name`、`original_filename`、`media_type`、`size_bytes`、`sha256`、`workspace_relative_path`、`source_ref`、`provenance`、`created_at`。
   - `source_type` 预留 `uploaded_file`、`ragflow_document`、`ragflow_chunk`、`agent_artifact`、`qizhi_local_file`；第一阶段只写入 `uploaded_file`。
   - `workspace_relative_path` 永远是任务目录内相对路径，不能存绝对路径或用户提供的路径。
3. `task_input_audits`：上传、冻结、下载和未来知识库发布的审计事件。
   - `id`、`task_id` 可空、`task_input_id` 可空、`upload_id` 可空、`action`、`actor_subject`、`detail`、`created_at`。

索引：暂存表按 `(owner_subject, state, expires_at)`，任务资料表按 `(task_id, created_at)`，审计表按 `(task_id, created_at)`。

## 工作目录约定

```text
<task-workspace>/
  task.json
  state.json
  inputs/
    <task-input-id>/
      original/
        <sanitized-original-filename>
      provenance.json
  nodes/
    <node-key>/
      input/
        task-inputs/
          <task-input-id>-<sanitized-original-filename>
      output/
```

上传暂存文件位于独立的 `<workspace-root>/uploads/<upload-id>/blob`，不允许直接成为任务输入。任务创建时由服务器复制并计算/核对摘要，在任务目录生成不可变快照。智能体节点只收到复制到其 `input/task-inputs` 下的文件，并通过执行信封获得资料清单与已分配路径。

## API 契约

### 1. 暂存上传

`POST /v1/task-inputs/uploads`

- `multipart/form-data`，单次一个 `file` 字段；前端会逐个上传多个文件。
- 响应：`{ upload: { id, displayName, originalFilename, mediaType, sizeBytes, sha256, expiresAt } }`。
- 默认限制：单文件 100 MiB、一个任务至多 25 个文件、合计 500 MiB。服务配置提供同名环境变量，实际上传与任务冻结均再次校验。
- 拒绝空文件、路径分隔符/控制符文件名、超限、过期或不属于当前主体的暂存资料。保存时使用服务端 ID，而不是客户端文件名作为目录名。

### 2. 创建任务并冻结资料

`POST /v1/tasks`

```json
{
  "goal": "基于附件完成项目介绍",
  "acceptanceMode": "platform",
  "inputIds": ["upload-id-a", "upload-id-b"]
}
```

创建服务先完成任务目录、数据库任务记录和资料冻结；所有 `inputIds` 校验通过并成功复制后，才进入规划队列。响应中的任务详情带 `inputs` 的安全元数据，不暴露暂存路径、工作目录绝对路径或内部凭据。

### 3. 任务资料查看和下载

- `GET /v1/tasks/:taskId` 增加 `inputs`。
- `GET /v1/tasks/:taskId/inputs/:inputId/download` 以受控下载方式提供冻结的原始文件，并以审计记录该动作。
- 后续 RAGFlow/栖知来源使用与 `task_inputs` 相同的输出结构，避免前端或编排层按来源分叉。

## 中台规划与智能体交互

1. `TaskService` 将任务资料的**清单**（名称、来源类型、媒体类型、字节数、摘要；可选可提取文本的概述）传给规划器。原始二进制不进入提示词，也不进入事件流。
2. 规划协议新增 `taskInputBindings`。每个节点可声明 `inputId`、该节点输入 schema 中的目标字段和使用说明。它与既有 `inputBindings`（上游节点输出依赖）完全分开。
3. 计划编译器验证：被引用资料属于该任务、目标字段存在于所选智能体输入 schema、文件类型允许被该智能体处理；不合法计划拒绝执行并留下可读审计。
4. 调度器在节点租约开始前物化该节点的 `taskInputBindings`，创建节点私有副本；执行信封含 `taskInputs` 元数据和相对工作路径。中台事件记录“已向某节点授予 N 项任务资料”，不打印资料内容。
5. 运行时或智能体通过现有心跳、结构化进度和结果协议继续工作。若智能体产出引用了任务资料，产物/证据应使用 `taskInputId`、摘要和页码/段落等可追溯信息，而不是复制机密内容到日志。

## 控制台体验

- “输入需求信号”区域增加多文件选择、已选文件清单、大小、移除按钮和上传/冻结阶段状态。
- 点击提交时先逐个上传，并显示“正在上传 x/y”；全部成功后才创建任务。如创建失败，已上传暂存资料保留到到期，可由后续清理任务回收。
- 任务详情增加“任务资料”区域：显示名称、来源、类型、大小、摘要、冻结时间和下载入口。
- 实时 SSE 增加 `task_input_uploaded`、`task_inputs_frozen`、`task_inputs_bound` 等可读事件；不得将文件内容、绝对路径或令牌写入控制台。

## 实施步骤与验证点

### 步骤 1：输入资料领域模型与安全存储

修改：数据库数据源、迁移、配置、`TaskWorkspaceService`，新增 `TaskInputService` 和单元测试。

- 增加迁移和实体/查询方法；更新数据库字段说明。
- 增加文件名净化、相对路径约束、sha256、大小限制、暂存到期判断、任务快照复制与审计。
- 在任务详情加载安全资料元数据。
- 测试：迁移可在测试库执行；越界文件名/路径被拒绝；冻结文件摘要一致；非本任务资料无法读取。

### 步骤 2：上传和任务创建 API

修改：Fastify 启动配置、任务输入控制器、任务 DTO/服务、端到端测试和模块文档。

- 注册受大小限制的 multipart 解析器，避免把上传内容整体置入内存。
- 实现上传、任务创建传入 `inputIds`、受控下载和错误响应。
- 未传 `inputIds` 的既有 curl 和控制台调用必须保持兼容。
- 测试：用 multipart 上传样例文件，创建任务后检查 DB 记录/任务目录/下载内容；超限、过期、重复跨任务、未知 ID 返回清晰 4xx。

### 步骤 3：规划协议、编排校验和节点物化

修改：`agent-protocol` schema/types、规划器提示词及计划编译器、调度器、执行信封、相关测试。

- 将资料清单传给 Codex 规划请求，要求模型只在确有需要时创建 `taskInputBindings`。
- 扩展 JSON schema，验证节点对任务资料的最小权限绑定。
- 物化节点私有资料副本、写入可读状态事件、并将相对路径注入执行输入。
- 测试：计划含资料绑定时仅目标节点可看到副本；没有绑定的节点无法看到；非法绑定被拒绝；节点重试可重建相同快照。

### 步骤 4：控制台、SSE 与运维文档

修改：控制台任务表单/详情页/样式、接口文档、数据库设计和运行手册。

- 实现多文件选择、上传进度、资料清单、下载；不把文件转换为 JSON/base64。
- 在时间线和开发控制台展示资料生命周期事件，前台文案使用可读的中文。
- 写出 curl 示例、配置说明、清理策略、任务私有资料和未来 RAGFlow/栖知接入边界。
- 测试：控制台构建成功；既有任务详情无资料时正确显示；含资料任务可展示且下载链接可用。

### 步骤 5：回归、部署与实际验证

- 对隔离测试数据库运行完整单元/端到端测试、类型检查、智能体自检和前端构建。
- 部署到 219 服务器，重启控制平面；用管理员接口上传一个无敏感样例文件、创建任务并核查资料冻结/下载/时间线。
- 检查服务日志不泄漏文件内容、路径或令牌，并记录部署验证结果。

## 完成标准

1. 用户可用控制台或 curl 将 1 至 25 个文件附加到一个需求信号。
2. 每个任务取得自己不可变的资料快照；其他任务和未被绑定的节点不能读取它。
3. 规划、编排、节点输入和实时事件都能说明资料如何被使用，但不泄露资料正文。
4. 智能体可在自身任务目录内取得中台明确授予的资料，返工仍使用同一快照。
5. 上传、冻结、绑定、下载均有结构化审计；数据库、模块接口与运维说明完整。
6. 既有无附件任务、RAGFlow 查询、PPT、质量验收和返工流程通过回归测试。
