# 知识库查询 Agent：curl 调用

中台服务在 219 服务器的 `127.0.0.1:3010` 监听。管理员先通过 SSH 登录 219，再使用固定管理员令牌发出需求信号：

```bash
export MG_ADMIN_TOKEN='由管理员安全保存的固定令牌'
curl --fail-with-body --silent --show-error \
  -X POST http://127.0.0.1:3010/v1/tasks \
  -H "Authorization: Bearer $MG_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"goal":"查询企业知识库中与味道府相关的客户资料"}'
```

## 实际链路

1. 中台校验管理员令牌并创建持久化任务、计划节点、租约和独立工作目录。
2. 中台只在 `agent_versions` 中选择状态为 `ready` 的
   `ragflow-knowledge` 版本。
3. 智能体向 RAGFlow 发起只读检索。未指定数据集时，中台只使用该服务密钥可见的数据集，并逐个查询，避免不同嵌入模型的数据集被混合提交。
4. 智能体按 `started → progress → checkpoint → completed` 回传带租约的事件；中台持久化事件、结果、来源证据和自动验收决定。

成功响应包含 `taskId`、实际选择的 `agentVersionId`、任务状态和证据列表。每段证据包含稳定来源、数据集 ID、文档 ID、标题、摘录与相似度。任何 RAGFlow 密钥和管理员令牌均不会出现在响应、数据库事件或仓库文件中。
