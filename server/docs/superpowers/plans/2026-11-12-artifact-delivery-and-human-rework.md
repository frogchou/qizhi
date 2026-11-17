# 任务产物交付与人工返工实施计划

> **执行方式：** 当前会话按 `executing-plans` 内联执行；每项均先写失败测试，再作最小实现并运行对应验证。

**目标：** 让任务产物可安全下载与预览；在质量失败时由管理员决定接受或携带上一版交付和质检意见返工，并保留完整版本与审计轨迹。

**设计依据：** `docs/superpowers/specs/2026-11-12-artifact-delivery-and-human-rework-design.md`

**技术栈：** NestJS/Fastify、TypeORM/PostgreSQL、Node 文件系统、React/Vite、Vitest、SSE、systemd。

## 全局约束

- 所有下载、预览和人工决定必须经过现有管理员认证；令牌不得出现在 URL、活动流、日志或任务目录。
- 智能体原始工件必须先通过现有相对路径、存在性和 SHA-256 校验，才可归档并暴露下载。
- 工件归档路径只能位于对应任务根目录；任何绝对路径、目录穿越或符号链接逃逸必须拒绝。
- 质量失败后不再自动返工；每一轮返工都必须由人工明确触发。
- 返工只重置 PPT 节点与依赖它的质量节点，已完成资料检索保持完成；历史输出与工件不得被覆盖。
- 每个功能模块补充说明文档；数据库迁移在数据库设计文档中列出字段含义。

## 任务 1：持久化、归档并读取安全工件

**文件：**

- 新建：`apps/control-plane/src/database/migrations/0004-task-artifacts-and-rework.ts`
- 新建：`apps/control-plane/src/tasks/task-artifact.service.ts`
- 修改：`apps/control-plane/src/database/data-source.ts`
- 修改：`apps/control-plane/src/tasks/task-workspace.service.ts`
- 修改：`apps/control-plane/src/internal/instance-results.service.ts`
- 修改：`apps/control-plane/src/app.module.ts`
- 新建：`apps/control-plane/src/tasks/ARTIFACT_DELIVERY.md`
- 修改：`apps/control-plane/src/tasks/README.md`
- 测试：`tests/control-plane/instance-results.e2e-spec.ts`
- 新建测试：`tests/control-plane/task-artifact.service.spec.ts`

**接口：**

- `TaskArtifactService.archiveVerifiedArtifacts(...)`：将已验证工件复制到 `artifacts/nodes/<node-id>/revision-<n>/`，写入 `task_artifacts`，返回无服务器绝对路径的元数据。
- `TaskArtifactService.list(taskId)`：返回任务内归档工件及来源、版本、时间、大小、哈希和安全媒体类型。
- `TaskArtifactService.openForDownload(taskId, artifactId)`：验证任务归属、数据库存储路径和真实路径约束后返回文件句柄/元数据。

- [ ] 先为“成功结果回调产生稳定归档记录，下一次节点输出变化也不影响旧版本”写失败集成测试；为未知工件、越界工件和 SHA 不匹配写拒绝测试。
- [ ] 运行 `corepack pnpm vitest run tests/control-plane/instance-results.e2e-spec.ts tests/control-plane/task-artifact.service.spec.ts`，确认归档服务/表尚不存在而失败。
- [ ] 编写迁移：新增 `task_artifacts` 和 `task_attempts.result`；实现受限归档服务、文件类型映射、真实路径/符号链接保护与模块注入。
- [ ] 在结果回调中仅在验证成功后写尝试结果、归档工件和节点输出；保留事务/失败补偿的可读活动信息。
- [ ] 复跑聚焦测试，检查归档文件与数据库字段实际匹配；更新模块文档与字段表。

## 任务 2：提供受认证工件下载与任务详情索引

**文件：**

- 修改：`apps/control-plane/src/tasks/tasks.controller.ts`
- 修改：`apps/control-plane/src/tasks/tasks.service.ts`
- 修改：`apps/control-plane/src/app.module.ts`
- 新建测试：`tests/control-plane/task-artifacts.e2e-spec.ts`
- 修改：`apps/control-plane/src/tasks/ARTIFACT_DELIVERY.md`

**接口：**

- `GET /v1/tasks/:taskId` 返回 `artifacts` 列表，不含绝对路径。
- `GET /v1/tasks/:taskId/artifacts/:artifactId` 使用管理员认证以二进制流下载；设置受控 MIME、附件文件名和 `X-Content-Type-Options: nosniff`。

- [ ] 先写 HTTP 测试：无认证被拒绝、正确任务与工件能取得字节内容及附件响应头、工件属于另一任务或不存在时不能读取。
- [ ] 运行聚焦 HTTP 测试，确认路由尚不存在而失败。
- [ ] 将工件服务注入任务服务；实现受保护流式响应和详情工件索引，禁止从请求参数拼接文件路径。
- [ ] 复跑测试，确认 PPT/JSON 均以下载形式传输，且任务边界不能越过。

## 任务 3：把质量失败改为人工决定，并构造返工上下文

**文件：**

- 修改：`apps/control-plane/src/tasks/task-scheduler.service.ts`
- 修改：`apps/control-plane/src/tasks/tasks.service.ts`
- 修改：`apps/control-plane/src/tasks/tasks.controller.ts`
- 修改：`apps/control-plane/src/tasks/task-workspace.service.ts`
- 修改：`apps/control-plane/src/tasks/task-session.service.ts`
- 修改：`apps/control-plane/src/tasks/README.md`
- 修改：`apps/control-plane/src/tasks/ARTIFACT_DELIVERY.md`
- 修改：`tests/control-plane/task-scheduler.spec.ts`
- 新建测试：`tests/control-plane/task-review.e2e-spec.ts`

**接口：**

- `POST /v1/tasks/:taskId/review` 体为 `{ decision: 'accept' | 'rework' }`。
- 旧 `POST /v1/tasks/:taskId/approve` 保持兼容并调用接受分支。
- `TaskService.reviewTask()` 对质量失败构造返工周期，写入会话、活动和任务目录后投递调度器。

- [ ] 先把现有调度测试改为断言“首次质量失败不创建第二个 PPT 尝试，而是进入 `awaiting_review`”；观察它在旧自动返工行为下失败。
- [ ] 为 review API 写失败测试：非人工验收状态拒绝、质量通过时拒绝返工、接受能终结任务、质量失败时返工只重置 PPT/质量节点且保留检索节点。
- [ ] 为返工输入写失败测试：新 PPT 输入包含相对任务内路径的上一版 PPT、`quality-assessment.json`、`acceptance-criteria.json`、中文失败摘要；历史工件仍可列出。
- [ ] 实现质量失败停机、人工决定、返工周期快照、上下文材料复制与活动/会话记录；通过正常 `TaskSchedulerService.advance` 启动新的尝试。
- [ ] 复跑调度及 HTTP 测试，确认没有隐藏式自动循环和没有覆盖原输出。

## 任务 4：控制台交付区、文本预览与返工操作

**文件：**

- 修改：`apps/console/src/App.tsx`
- 修改：`apps/console/src/lib/task-presenter.ts`
- 修改：`apps/console/src/styles.css`
- 修改：`apps/console/README.md`
- 修改：`tests/console/task-presenter.spec.ts`
- 新建测试：`tests/console/artifact-download.spec.ts`

**接口：**

- 以 `Authorization` 请求工件二进制并由 `Blob` 下载；不产生带令牌的链接。
- JSON、Markdown、TXT 以同一认证请求读取，并在转义文本预览框中显示；PPT 仅下载。
- `awaiting_review` 且质量失败时显示“确认当前交付”和“根据质检意见返工”；其他人工验收仅显示适用的确认动作。

- [ ] 先写演示层测试：任务详情中的工件渲染下载按钮和版本信息；失败质量显示两个可读决定；普通人工验收不出现返工。
- [ ] 先写下载辅助函数测试：请求含 Authorization、读取二进制并从响应头使用安全文件名；文本预览不把内容作为 HTML 注入。
- [ ] 运行控制台聚焦测试，确认当前纯文件名展示不能满足断言。
- [ ] 实现工件 presenter、下载/预览对话框、返工确认动作、SSE 后的详情刷新和响应式样式。
- [ ] 复跑控制台测试和生产构建。

## 任务 5：全量验证、部署和真实流程检查

**文件：**

- 修改：`docs/runbooks/control-console.md`
- 修改：`docs/runbooks/task-observability.md`
- 修改：`apps/control-plane/src/tasks/README.md`（如验证改变操作说明）

- [ ] 运行完整 Vitest、TypeScript 检查、控制台生产构建和智能体声明校验。
- [ ] 使用测试数据库运行迁移重放，确认 0004 可从空库完整建立也可对当前 219 数据库增量执行。
- [ ] 同步代码到 219 的现有功能分支，执行迁移，重启控制面与节点管理服务。
- [ ] 通过管理员控制台验证：历史失败任务可列出/下载现有归档（如无历史归档则通过新测试任务生成）；质量失败显示人工决定；返工后时间线出现返工上下文、PPT 重启和新的工件版本。
- [ ] 检查 systemd 日志中没有令牌、RAGFlow 密钥或绝对任务路径泄露；记录安全的排障与验证步骤。

## 评审重点

- 下载端点是否仅能读取该任务中经 SHA 校验并归档的工件，且不会被路径或符号链接绕过。
- 质量失败是否确实不再自动重试，人工返工是否只影响 PPT/质量的依赖子图。
- 下一次 PPT 是否收到“上一版产物 + 验收标准 + 质检结果 + 中文失败摘要”四类可读取输入，而不是只有笼统提示。
- 旧版交付在返工后是否仍可下载，数据库、任务会话、活动流三处是否均保留审计线索。
- 控制台是否能在不暴露管理令牌的前提下完成下载、预览和决定，并在 SSE 更新后反映新状态。
