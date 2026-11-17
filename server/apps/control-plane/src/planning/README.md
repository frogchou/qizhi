# 任务规划（Planning）

本目录是“中台分析需求、选择能力、产出执行图”的唯一入口。它不执行智能体代码，也不把模型自由文本当作计划。

## 边界

1. `CapabilityCatalogService` 仅从 PostgreSQL 中 `ready` 状态、且已通过声明 Schema 校验的审批快照读取能力、运行时、启动命令和输入/输出 Schema；不会扫描或导入磁盘中的智能体代码。声明无效的版本会在注册发现、批准或启动恢复阶段被拒绝或隔离，因而不会让任务在调用 Codex 前因某个历史智能体版本而失败。
2. `CodexPlannerService` 将用户目标和上述能力目录交给本机 Codex CLI，并要求其遵守 `planner-output.schema.json`。为了兼容 Codex 严格结构化输出，节点理由使用显式对象数组，任务图使用 `planJson` 字符串返回；中台会立即将其还原并用 Agent Protocol 校验为任务图。只保存面向用户的摘要、假设、风险和节点理由，不保存模型思维过程。
3. `PlanningService` 使用 Agent Protocol 编译器校验能力存在性、输入 Schema、依赖图、绑定关系和路径安全。校验失败时只允许一次带错误说明的修复请求。
4. 编译通过后，将原始结构化规划和绑定后的编译计划写入任务目录 `plans/`，同时写入 `task_plans`、`tasks.planner_summary` 和 `session/conversation.jsonl`。此时尚未拉起任何智能体。

## 任务目录文件

- `plans/plan-vN.json`：Codex 产生且已通过编译的结构化计划（不是思维过程）。
- `plans/compiled-plan-vN.json`：已绑定特定已审核智能体版本的可执行图。
- `session/conversation.jsonl`：规划完成、修复请求或最终失败的可读记录。
- `state.json`：任务目录当前阶段的原子快照。

如果两次规划都未通过，任务进入 `planning_failed`，不会产生可被调度的执行图。
