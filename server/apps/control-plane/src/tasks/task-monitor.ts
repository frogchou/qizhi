export type MonitorStageState = 'cancelled' | 'stopping' | 'pending' | 'running' | 'succeeded' | 'failed' | 'awaiting_review' | 'awaiting_user_input';
export type MonitorStage = { key: string; label: string; state: MonitorStageState; startedAt: string; endedAt?: string; durationMs?: number; details: string[] };

type RecordRow = Record<string, unknown>;
type MonitorInput = { task: RecordRow; nodes: RecordRow[]; attempts: RecordRow[]; events: RecordRow[]; interactions?: RecordRow[] };

/** Turns durable control-plane records into the operator-facing workflow view. */
export function projectWorkflowStages(input: MonitorInput): MonitorStage[] {
  const createdAt = timestamp(input.task.created_at) ?? new Date().toISOString();
  const taskState = text(input.task.state);
  const received = stage('signal_received', '需求接收', 'succeeded', createdAt, createdAt, ['需求信号已记录。']);
  if (taskState === 'cancelled' || taskState === 'stopping') {
    return [received, stage('stop', taskState === 'stopping' ? '正在停止任务' : '任务已停止', taskState, createdAt, timestamp(input.task.updated_at), [])];
  }
  if ((input.task.planner_summary as { mode?: string } | null)?.mode === 'direct_answer') {
    return [received, stage('direct_answer', '中台答复', 'succeeded', createdAt, timestamp(input.task.updated_at), [])];
  }
  const nodes = input.nodes;
  const firstNodeAt = earliest(nodes.map((node) => timestamp(node.created_at))) ?? createdAt;
  const lastNodeAt = latest(nodes.map((node) => timestamp(node.updated_at)));
  const events = [...input.events].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const executionState = aggregateExecutionState(nodes, input.attempts, taskState);
  const eventDetails = events.map((event) => `${formatTime(timestamp(event.occurred_at))} · ${text(event.event_type)}${formatPayload(event.payload)}`);
  const accepted = taskState === 'accepted';
  const failed = taskState === 'failed';
  const planningFailed = taskState === 'planning_failed';
  const capabilities = [...new Set(nodes.map((node) => text(node.capability)).filter(Boolean))];
  const completedCount = nodes.filter((node) => ['completed', 'succeeded'].includes(text(node.state))).length;
  const runningCount = nodes.filter((node) => ['running', 'leased', 'leasing'].includes(text(node.state))).length;
  const pendingCount = nodes.filter((node) => ['pending', 'interrupted'].includes(text(node.state))).length;
  const pendingInteraction = (input.interactions ?? []).find((interaction) => text(interaction.state) === 'pending');
  const nodeNames = nodes.map((node) => text(node.node_key)).filter(Boolean);
  return [
    stage('signal_received', '需求接收', 'succeeded', createdAt, createdAt, ['需求信号已记录，已创建持久化任务。']),
    stage('intent_analysis', '中台意图分析', planningFailed ? 'failed' : nodes.length || ['planned', 'running', 'awaiting_user_input', 'awaiting_review', 'accepted'].includes(taskState) ? 'succeeded' : 'running', createdAt, nodes.length ? firstNodeAt : undefined, planningFailed ? ['中台无法从当前已审核能力中编译出可执行计划。'] : nodes.length ? [`已从自然语言需求形成 ${nodes.length} 个可执行节点。`] : ['正在读取已审核智能体能力并分析用户需求。']),
    stage('orchestration', '智能体编排', planningFailed ? 'failed' : nodes.length ? 'succeeded' : 'pending', firstNodeAt, nodes.length ? firstNodeAt : undefined, nodes.length ? [`已编排 ${nodes.length} 个节点：${nodeNames.join('、')}。`, `覆盖能力：${capabilities.join('、') || '待确定'}。`] : ['等待意图分析生成可验证的执行图。']),
    stage('agent_execution', '智能体工作', executionState, firstNodeAt, executionState === 'running' || executionState === 'awaiting_user_input' ? undefined : lastNodeAt, taskState === 'awaiting_user_input' ? [`任务已暂停，等待${text(pendingInteraction?.source) === 'agent' ? '智能体所需的' : '中台请求的'}用户输入：${text(pendingInteraction?.title) || '未命名问题'}。`, `节点状态：已完成 ${completedCount}，执行中 ${runningCount}，等待 ${pendingCount}。`] : eventDetails.length ? [`节点状态：已完成 ${completedCount}，执行中 ${runningCount}，等待 ${pendingCount}。`, `当前能力：${capabilities.join('、') || '待分配'}。`, ...eventDetails] : [`节点状态：已完成 ${completedCount}，执行中 ${runningCount}，等待 ${pendingCount}。`, '等待智能体生命周期事件上报。']),
    stage('acceptance', '结果验收', accepted ? 'succeeded' : failed || planningFailed ? 'failed' : taskState === 'awaiting_review' ? 'awaiting_review' : executionState === 'running' || executionState === 'pending' || executionState === 'awaiting_user_input' ? 'pending' : 'running', lastNodeAt ?? firstNodeAt, accepted || failed || planningFailed || taskState === 'awaiting_review' ? timestamp(input.task.updated_at) : undefined, accepted ? ['交付已验收，可在验收记录查看决定。'] : failed || planningFailed ? ['任务执行失败，请查看智能体事件与错误结果。'] : taskState === 'awaiting_review' ? ['等待人工或平台审批。'] : executionState === 'succeeded' ? ['中台正在核验用户原始需求。'] : ['等待所有必需节点完成后开始验收。']),
  ];
}

function stage(key: string, label: string, state: MonitorStageState, startedAt: string, endedAt: string | undefined, details: string[]): MonitorStage {
  const durationMs = endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
  return { key, label, state, startedAt, endedAt, durationMs, details };
}
function aggregateExecutionState(nodes: RecordRow[], attempts: RecordRow[], task: string): MonitorStageState {
  if (task === 'failed' || task === 'planning_failed' || nodes.some((node) => text(node.state) === 'failed') || attempts.some((attempt) => text(attempt.state) === 'failed')) return 'failed';
  if (task === 'awaiting_user_input' || nodes.some((node) => text(node.state) === 'awaiting_user_input') || attempts.some((attempt) => text(attempt.state) === 'yielded')) return 'awaiting_user_input';
  if (!nodes.length) return task === 'planning' || task === 'received' ? 'pending' : 'running';
  if (nodes.some((node) => ['running', 'leased', 'leasing'].includes(text(node.state))) || attempts.some((attempt) => ['leased', 'running'].includes(text(attempt.state)))) return 'running';
  if (nodes.every((node) => ['completed', 'succeeded'].includes(text(node.state)))) return 'succeeded';
  return 'pending';
}
function timestamp(value: unknown): string | undefined { return value instanceof Date ? value.toISOString() : typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function formatTime(value: string | undefined): string { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'; }
function formatPayload(value: unknown): string { return value && typeof value === 'object' ? ` · ${JSON.stringify(value)}` : ''; }
function earliest(values: Array<string | undefined>): string | undefined { return values.filter((value): value is string => Boolean(value)).sort()[0]; }
function latest(values: Array<string | undefined>): string | undefined { return values.filter((value): value is string => Boolean(value)).sort().at(-1); }
