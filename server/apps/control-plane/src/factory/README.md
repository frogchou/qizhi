# 栖知智能工厂读取接口

所有路径均以 `/v1/factory` 开头，使用与控制台相同的管理员 Bearer 凭据。每个抽屉通过 GET 获取数据。任务操作、验收决定和制品下载沿用 `/v1/tasks` 接口，注册版本的变更由发布管理接口处理。

## 快照、变更与分页

`GET /overview` 返回 `{cursor,observedAt,areas,recentActivities}`。每个厂区返回 `{count,summary,metrics}`，资产区另含知识库连接状态。数据库投影使用同一 PostgreSQL 可重复读快照，包含全部历史工单。时间以 ISO 8601 返回。知识库有独立的 `connection.observedAt`。

列表使用 `?limit=25&offset=0`，每页 1 至 100 行。返回 `{items,total,limit,offset,observedAt}`。数据库列表返回同一快照内符合筛选条件的总数，包括页码越界时的总数。跨页浏览期间服务仍可接单，列表随新快照变化。实时回放另用游标。记录带稳定标识。

`GET /changes?after=<cursor>&waitMs=15000` 返回 `{items,registryChanges,cursor,hasMore,observedAt}`。传回服务端给出的整个游标，字符串 `0` 可从账本起点开始。最长等待 25 秒。两个账本每次各返回最多 80 项。工单活动字段为 `id,taskId,kind,state,message,detail,source,occurredAt`；注册表审计仅返回 `id,action,agentId,version,occurredAt`。每类事件独立按 ID 升序。客户端使用事件 ID 去重，处理完一页后保存游标。若 `hasMore` 为真，立即读取下一页。

快照在投影前先取得已提交的活动和审计高水位。读取高水位时短暂对追加表持有共享锁，使用 NOWAIT 避免等待正在写账本的事务。若有尚未提交的事务，增量读保留旧游标重试，快照采用可重放的游标。这样即使数据库先提交了较大的序列号，较小的序列号也不会被跨过。此设计适用于当前服务的单库、自增主键、追加式账本、默认序列 CACHE 1 和表内分配 ID 的写入路径。

工单状态更新和活动落账可能相隔一小段时间。客户端从快照游标开始回放，收到变更后重读当前投影。在长轮询到期、返回页面和重新连接时也重读快照，以更新心跳超时、进程资源、外部知识库和尚未产生独立活动的数据库变化。浏览完历史页后以新快照恢复当前工作区。

## 厂区统计

| 厂区 | 主数值 | 指标说明 |
| --- | --- | --- |
| intake | 接收工单总数 | `tasks` 全部、`received` 仍处于接收态、`channels` 三个已实现的提交入口。来源数为 `api,console,qizhiDesktop,unknown` |
| control | 在办工单 `activeTasks` | 在办包括 `received,planning,planned,running,awaiting_user_input,awaiting_review,stopping`。按阶段返回 `received,planning,planned,running,awaitingUserInput,awaitingReview,stopping`，另计已验收交付 `accepted`、规划失败 `planningFailed`、计划版本数 `plans`。`readyVersions,pendingReviewVersions,offlineVersions` 来自注册表 |
| line | 当前计划正在执行的节点 | `agents` 已注册的不同智能体、`runningAgents` 正在执行的不同智能体、`runningNodes,activeTasks,retrievingNodes,readyVersions,pendingReviewVersions` |
| quality | 等待人工决定的工单 | `pendingReview,checking,supplement,rework,accepted,assessed` 按每张工单当前阶段计数。`failed` 是有未满足要求或明确失败质检报告的工单，`automaticPassed` 要求存在通过证据且由平台自动验收 |
| assets | 已冻结的任务资料与归档制品数之和 | `inputs,artifacts,sessions,configuredDatasets`。sessions 指有独立工作目录记录的工单数；文件系统中的对话条数不参与该指标。成功读取目录后提供 `connectedDatasets` |
| runtime | 仍持有租约或正在停止的尝试 | `active,attempts,readyRuntimes,planning`。planning 是规划中的工单数 |
| monitor | 当前超过存活时限的在办实例 | `events,heartbeats,livenessLost` 为持久化历史；`failedTasks` 为当前执行或规划失败的工单；`staleInstances` 采用存活监督服务相同的首报 20 秒、后续 45 秒及状态条件 |
| delivery | 已验收工单数 | `accepted,withArtifacts,artifacts`。文件统计包含该组工单中保留的历次归档制品 |

## 抽屉数据

| 路径 | 返回的对象 | 可选筛选 |
| --- | --- | --- |
| /tasks | 每张工单的 `id,taskId,goal,state,acceptanceMode,sourceSystem,planVersion,planMode,planSummary,createdAt,updatedAt` | `taskId,state,sourceSystem,agentId,version`，`area=intake\|control\|line`。intake 为全部，control 为所有在办工单，line 为当前计划中实际正在执行的节点所属工单。可单独按 state 选择已验收或执行中的工单 |
| /agents | 每个注册版本的 `id,agentId,displayName,version,status,protocolVersion,runtime,capabilities,createdAt,approvedAt,runningCount`。能力展示只读取 name 和 description，未审核版本以注册表状态标记 | `agentId,version,status`。working 匹配仍有租约的版本。pending_review、self_checking、self_check_failed、ready、offline 匹配对应注册状态 |
| /quality | 每张相关工单最新一轮或实际质检记录。含 `taskId,goal,state,status,acceptanceMode,reviewId,round,decision,acceptedBy,verdict,reviewRequired,missingCount,uncertainCount,reportedGaps,updatedAt` | `taskId,status`。状态有 pending_review、checking、supplement、rework、accepted、assessed。额外可传 automatic_passed 或 failed |
| /assets | 本工厂已配置且本次服务凭据能读取的 RAGFlow 数据集。`{id,name,configured,documentCount,chunkCount}` | 列表分页。响应另含 `connection` 与 `metrics.inputCount,artifactCount,sessionCount` |
| /runtimes | 每次执行尝试的 `id,instanceId,taskId,goal,nodeKey,capability,agentId,agentVersion,runtime,state,unitName,attemptNumber,createdAt,updatedAt,lastHeartbeatAt,metrics` | `taskId,agentId,version,runtime,state`。active 包含 leased 和 stopping。另返回全厂 `inventory`，含运行时 id、name、readyVersionCount、activeCount、attemptCount、planningCount |
| /sources | 每个入口的 `id,displayName,status,taskCount,lastReceivedAt` | `sourceSystem`。available 表示该产品接单路径已实现。unknown 单列历史缺失来源。not_connected 表示相应工具没有专用接单连接器 |
| /monitor | 按 ID 倒序的工单活动，与变更接口的活动字段相同 | `taskId,kind,source`。例如 agent_heartbeat、agent_liveness_lost、planning_failed，source 通常为 control_plane、node_manager 或 agent |
| /deliveries | 已验收工单的 `id,taskId,goal,state,acceptanceMode,answer,artifactCount,updatedAt`，包含纯文本答复 | `taskId`。制品元数据从对应工单详情取得，下载使用同任务的制品 ID |

验收阶段和验收证据分别返回。一项要求 missing 或质检智能体明确报告不通过时，verdict 为 failed；不确定项、评估错误和待人工判断的缺项为 uncertain。全部已核对条目通过或有通过的质检报告时为 passed。缺少历史核验记录时保留 pending 或 unrecorded。人工可以决定接收一个仍有缺项的交付，acceptedBy 和 verdict 会分别保留决定和依据。完整标准、证据与所有历史轮次在任务详情的 acceptanceRounds 中。

`GET /quality?status=pending_quality` 汇总正在核验（checking）和待人工决定（pending_review）两类，保留实际阶段，并在分页前筛选全部工单。生产线的 agents 列表在撤销启动资格期间展示 deleting；完成后，历史版本不计入注册目录与厂区智能体总数。可通过单独的 `GET /agents/:agentId/status` 查询身份状态。

知识库状态为 connected、unconfigured 或 unavailable。连接检查只使用带服务端凭据的只读数据集请求，总超时 3.5 秒，结果缓存 15 秒。配置了多个库时校验每个返回 ID；凭据可见的其他库不会出现在列表。visibleCount 和 /assets 的 total 在访问失败时为 null。连接成功但缺少某些配置库时，missingDatasetIds 给出相应 ID。接口仅在上游提供有效计数时展示文档数和分块数。

运行时资源取自与实例 ID 完全匹配的本机 systemd 服务 cgroup v2。cpuUsageUsec 是该服务累计 CPU 微秒数，memoryBytes 是本次读取的当前内存，pidsCurrent 是该控制组中的任务数。source 为 cgroup_v2。未启动、已完成、单元不匹配或无读取权限时用 null 和 reason 表示。资源采样和外部知识库访问均在数据库事务外进行。运行时库存保留已配置的 Codex 规划器，planningCount 仅计入已见规划器状态回报且仍在规划的工单。
