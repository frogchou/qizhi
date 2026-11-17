# 节点管理能力目录

节点管理服务不接受调用方提供的任意启动命令。中台只有在智能体通过审批和自检后，才会调用内部 `POST /internal/v1/catalog/ready-versions` 同步一条就绪记录：智能体 ID、版本、包路径与审核过的 `entryCommand`。

实例启动由 `SystemdSupervisor` 以确定性的 `mg-agent-<instance-id>` transient unit 提交，并使用 `--no-block` 返回“启动请求已被 systemd 接受”的回执。这个回执不是业务进程的存活证明：控制面仍以 Agent Protocol 首次心跳和后续心跳作为运行事实。节点管理服务把启动接受、启动失败及停止请求写入 journald 的结构化 JSON，便于和控制面按 `instanceId` 对照排查。

`PackageCatalogService` 将目录持久化在 `/home/middleground/data/node-manager/ready-catalog.json`，服务重启时恢复。启动实例时 `ControlService` 只能按 `agentId + version` 查找这份目录；未知、未就绪或未同步的版本会被拒绝。相对命令路径在同步时按智能体包路径解析，避免任务工作目录改变后执行到错误程序。

节点实例使用 transient systemd 单元运行。节点工作目录来自任务目录，环境配置通过 systemd `EnvironmentFile=` 载入；环境文件不写入能力目录、任务会话或前端响应。
