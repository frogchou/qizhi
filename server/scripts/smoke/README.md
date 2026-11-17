# 在线规划验收脚本

`planner.live.ts` 不创建任务、不写入业务数据库、不启动任何智能体实例。它只读取当前已审核且就绪的能力目录，然后使用与中台相同的 `CodexPlannerService`、`CodexCliRunner` 和任务图编译器，为固定需求“基于知识库中的栖知相关知识，生成一个栖知产品介绍PPT”做一次真实规划验收。

在 219 服务器上，以中台服务的环境文件提供只读配置后运行：

```bash
set -a
. /home/middleground/.secrets/control-plane.env
set +a
corepack pnpm exec tsx scripts/smoke/planner.live.ts
```

成功时输出 `status: "compiled"`、`attempts`、已采用能力版本和已编译节点。脚本与 `PlanningService` 一样，允许 Codex 根据编译错误修复一次任务图；这样可以核验规划结果既符合 Codex 的严格输出 Schema，又符合中台的 Protocol v1（能力、输入、依赖、绑定与工作目录）约束。运行中产生的 Codex 诊断文件只保存在输出的临时工作目录中，不会写入任务表。

失败时只输出工作目录，避免把提示词或敏感运行时诊断回显到终端；可由受权运维人员在该目录查看 `.mg-codex-stdout.log` 与 `.mg-codex-stderr.log`。
