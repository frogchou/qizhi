# 智能体编排运行手册

本文说明 219 服务器上中台、节点管理器、智能体目录和任务目录如何共同工作，以及上线后如何安全验证一条复杂需求。

## 运行边界

- 控制面服务：`mg-control-plane.service`。它保存任务、调用本机 Codex 形成受约束的执行图、验证计划并推进状态。
- 节点管理器：`mg-node-manager.service`。它只从已同步的 `ready` 目录启动短生命周期 systemd 实例，不能接受调用方提供的任意命令。
- 智能体目录：默认是工作树下的 `agents/`，也可通过 `MG_AGENT_PACKAGE_ROOT` 指定。每个一级目录必须含有 `agent.yaml` 与输入/输出 JSON Schema。
- 任务目录：`/home/middleground/data/workspaces/<task-id>/`。其中包含计划、会话、节点输入输出、工件及质量结果；不得出现令牌、密码或 API Key。
- 任务私有资料：任务根目录 `inputs/` 保存上传或未来知识库资料的冻结快照。调度器只会把计划中 `taskInputBindings` 明确授权的资料副本放到对应 `nodes/<node>/input/task-inputs/`；智能体不得读取其他任务目录或上传暂存区。

## 智能体登记与审核

控制面启动后会扫描并监听智能体目录。新目录被发现时只读取声明文件和 Schema，以 `system` 身份登记为 `pending_review`；不会导入、执行或自检其中的代码。

管理员在控制台的“待审批智能体”区域批准一个精确版本后，节点管理器才执行该版本的自检。自检成功后版本进入 `ready`，并将其已审阅启动命令同步到节点管理器目录。控制面或节点管理器重启时，控制面会重新同步所有已是 `ready` 的版本；不会借此批准任何待审核版本。

## 复杂任务的实际路径

以“制作一个关于 438c 项目介绍的 PPT”为例，Codex 计划器只能使用此刻已经审核且就绪的能力。正常情况下，编译后的图应包含：

1. 两个或更多可并行的知识检索节点，例如项目背景、建设目标与里程碑。
2. 等待全部证据文件物化完成后再启动的 PPT 节点；该节点由 Codex 运行时在自己的任务目录内生成 `presentation.pptx`。
3. 等待 PPT 工件复制至本节点输入目录后启动的质量节点；它建立验收标准并给出通过、返工或风险结论。

中台会验证能力存在、输入 Schema、依赖图、上游输入绑定、任务私有资料绑定、工件相对路径和租约。任务资料绑定只能引用该任务已经冻结的 ID，并且目标必须是智能体输入 Schema 中声明的数组字段。任一验证失败都不会启动智能体。质量验收未通过时中台保留交付物和质检意见，等待管理员确认当前交付或明确发起返工；不会隐藏式自动返工。

## 上线与验证

在工作树中先完成以下检查：

```bash
corepack pnpm run typecheck
corepack pnpm run console:build
corepack pnpm exec vitest run
```

随后先重启节点管理器，再重启控制面，使控制面恢复已审核目录并运行数据库迁移：

```bash
systemctl restart mg-node-manager.service
systemctl restart mg-control-plane.service
systemctl status mg-node-manager.service mg-control-plane.service
```

管理员登录控制台后，确认 `ppt-maker` 与 `quality-management` 均已审核为 `ready`，再提交 438c 需求。任务详情应展示多条知识检索、Codex PPT 制作、质量验收以及每个节点的证据、时长和运行摘要。

若知识库未返回足够证据，结果必须显示资料不足风险；PPT 和质量结论不得将缺失的企业事实当作已证实事实。

## 故障处理

- 节点没有启动：查看任务详情中的节点理由、生命周期事件和开发者调试区，再查看相应 `mg-agent-<instance-id>` systemd 单元。
- 节点管理器重启后找不到就绪智能体：确认控制面已成功启动；它会从 PostgreSQL 中重新同步 `ready` 版本。待审核版本不会自动启用。
- 任务中断：控制面启动时只会恢复租约过期且未收到结果的尝试；已接受的结果和工件不会重新运行。
- 质量未通过：任务进入人工审核；管理员可确认当前交付，或将已归档 PPT、验收材料及失败原因带入新的 PPT 返工，再重新验收。
