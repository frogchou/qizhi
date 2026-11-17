# 独立智能体运行时

`agent-runtime` 是所有被节点管理服务拉起的智能体的公共启动边界。它从 `MG_TASK_ENVELOPE_PATH` 读取 Agent Protocol v1 信封，要求其中提供任务根、节点工作目录和结果回调地址，并拒绝任何越出任务根的路径。

智能体业务代码获得 `AgentExecution`：用 `reporter` 发送有序事件，成功时调用 `complete(result)`，失败时调用 `fail(error)`。成功结果先原子写入 `nodes/<node-key>/result.json`，再通过 `{ leaseToken, result }` 回调中台。租约属于传输身份验证，`AgentResult` 本身保持可移植。

运行时在完成信封路径与时间戳校验后立即发送 `heartbeat`，并每 10 秒重复一次直到结果回调成功。这样中台能区分“systemd 接受启动请求”与“智能体进程已经实际引导”。业务实现仍应发送 `started`、`progress`、`checkpoint` 和终态事件；长时运行时可另发受限大小的 `output` 事件供管理员控制台查看。

`deadlineAt` 接受 JavaScript 标准 `Date#toISOString()` 生成的带毫秒 ISO 时间。运行时先校验协议结构，再用 `Date.parse` 校验其语义，避免不同 TypeBox 格式实现对 RFC 3339 小数秒处理不一致而阻止实例启动。

运行时不把令牌、密码或环境变量写入任务目录；连接 RAGFlow 等服务的凭据只能来自 systemd 的受限环境文件。
