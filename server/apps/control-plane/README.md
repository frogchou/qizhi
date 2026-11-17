# 控制平面

控制平面是企业智能体系统的控制层：它保存智能体目录、任务计划、任务状态、审批和审计记录，并通过节点管理服务调度智能体实例。

## 本模块的配置

配置只从进程环境读取。`infra/env/control-plane.env.example` 仅展示变量名称和非敏感样例；实际部署环境文件不进入 Git。

| 变量 | 作用 | 是否敏感 |
| --- | --- | --- |
| `MG_PORT` | 控制平面 HTTP 监听端口 | 否 |
| `DATABASE_URL` | PostgreSQL 连接字符串 | 是 |
| `MG_ADMIN_TOKEN_HASH` | 唯一管理员令牌的哈希 | 是 |
| `MG_NODE_MANAGER_URL` | 本机节点管理服务地址 | 否 |
| `RAGFLOW_BASE_URL` | 企业 RAGFlow 服务地址 | 否 |
| `RAGFLOW_API_KEY` | RAGFlow API 密钥 | 是 |
| `RAGFLOW_DATASET_IDS` | 逗号分隔的数据集白名单；知识检索智能体必须至少配置一个 ID，避免默认扩大检索范围 | 否 |

后续功能说明将与其实现放在同一目录。
