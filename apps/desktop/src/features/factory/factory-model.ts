import type { Area } from "./simulation";
import type { TaskScope } from "./assembly-model";

export type AreaSummary = {
  count: number;
  summary: string;
  metrics: Record<string, number>;
  connection?: {
    status: string;
    message: string;
    observedAt: string;
    visibleCount?: number | null;
    configuredCount?: number;
  };
};
export type Activity = {
  id: number | string;
  taskId: string;
  kind: string;
  state: string;
  message: string;
  detail?: {
    stage?: string;
    capability?: string;
    nodeKey?: string;
    instanceId?: string;
    text?: string;
  };
  source: string;
  occurredAt: string;
};
export type Overview = {
  observedAt: string;
  cursor: string;
  areas: Record<Area, AreaSummary>;
  recentActivities: Activity[];
};
export type Changes = {
  cursor: string;
  hasMore: boolean;
  items: Activity[];
  registryChanges?: {
    id: string | number;
    action: string;
    agentId: string;
    version: string;
    occurredAt: string;
  }[];
};
export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  observedAt: string;
};
export type Task = {
  id: string;
  taskId: string;
  goal: string;
  state: string;
  sourceSystem: string;
  acceptanceMode: string;
  planVersion: number | null;
  planMode?: string | null;
  planSummary?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Agent = {
  id: string;
  agentId: string;
  version: string;
  displayName: string;
  description?: string;
  runtime: string;
  status: string;
  createdAt: string;
  approvedAt?: string | null;
  capabilities: { name: string; description: string }[];
  runningCount: number;
  assembly?: {
    draftId: string;
    candidateId: string;
    runId: string;
    packageDigest: string;
  } | null;
  integrityIssue?: string | null;
};
export type Quality = {
  id: string;
  taskId: string;
  goal: string;
  state: string;
  status: string;
  reviewId: string | null;
  round: number | null;
  decision: string | null;
  acceptanceMode: string;
  acceptedBy: string | null;
  verdict: string;
  missingCount: number;
  uncertainCount: number;
  reportedGaps: string[];
  updatedAt: string;
};
export type Source = {
  id: string;
  displayName: string;
  status: string;
  taskCount: number;
  lastReceivedAt: string | null;
};
export type Dataset = {
  id: string;
  name: string;
  configured: boolean;
  documentCount: number | null;
  chunkCount: number | null;
};
export type AssetPage = Omit<Page<Dataset>, "total"> & {
  total: number | null;
  connection: {
    status: string;
    message: string;
    observedAt: string;
    configuredCount: number;
    visibleCount: number | null;
    missingDatasetIds?: string[];
  };
  metrics: Record<string, number>;
};
export type RuntimeJob = {
  id: string;
  instanceId: string;
  taskId: string;
  goal: string;
  nodeKey: string;
  agentId: string;
  agentVersion: string;
  runtime: string;
  state: string;
  unitName?: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  metrics: {
    available: boolean;
    source: string | null;
    cpuUsageUsec: number | null;
    memoryBytes: number | null;
    pidsCurrent: number | null;
    observedAt: string | null;
    reason?: string | null;
  };
};
export type RuntimePage = Page<RuntimeJob> & {
  inventory: {
    id: string;
    name: string;
    readyVersionCount: number;
    activeCount: number;
    attemptCount: number;
    planningCount: number;
  }[];
};
export type Delivery = {
  id: string;
  taskId: string;
  goal: string;
  state: string;
  updatedAt: string;
  artifactCount: number;
  answer: string | null;
};
export type PlanSummary = {
  mode?: string;
  intent?: string;
  summary?: string;
  deliverables?: string[];
  risks?: string[];
};
type PlanNode = {
  id: string;
  type: string;
  capability?: string;
  agentId?: string;
  agentVersion?: string;
  dependsOn?: string[];
};
export type TaskPlan = {
  id: string;
  version: number;
  state: string;
  created_at: string;
  plan: {
    nodes?: PlanNode[];
    planner?: PlanSummary;
    nodeReasons?: Record<string, string>;
  };
};
export type TaskNode = {
  id: string;
  plan_id: string;
  node_key: string;
  state: string;
  display_title?: string;
  rationale?: string;
  capability?: string;
  agent_id?: string;
  agent_version?: string;
  depends_on?: string[];
  output?: {
    output?: {
      assemblyVerification?: { receipts: AssemblyReceipt[] };
      summary?: string;
      answer?: string;
      message?: string;
      passed?: boolean;
      findings?: { id?: string; title?: string; message?: string }[];
      text?: string;
    };
    error?: { message?: string } | string;
    evidence?: { title?: string; source?: string; excerpt?: string }[];
  } | null;
};
export type AssemblyReceipt = {
  status?: string;
  requestKey?: string;
  resource: string;
  effect: string;
  mode: "real" | "simulated" | "unverified";
  provider?: string;
  reason?: string;
};
export type Attempt = {
  id: string;
  instance_id: string;
  task_node_id: string;
  attempt_number: number;
  state: string;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};
export type Round = {
  id: string;
  revision_number?: number;
  round: number;
  decision: string | null;
  created_at: string;
  decided_at: string | null;
  criteria: { id: string; requirement: string }[];
  assessment: {
    review?: boolean;
    deliveries?: { node: string; answer: string; files?: string[] }[];
    error?: string;
    items?: {
      id: string;
      status: string;
      reason: string;
      evidenceIds?: string[];
    }[];
    evidence?: { id: string; node: string; source: string; text: string }[];
    reportedGaps?: string[];
  };
};
export type TaskDelivery = {
  revisionNumber: number;
  answers: {
    nodeKey: string;
    title: string;
    body: string;
    format: "markdown" | "text";
  }[];
  artifactIds: string[];
  supportingArtifactIds: string[];
};
export type TaskDetail = {
  delivery?: TaskDelivery;
  task: {
    id: string;
    goal: string;
    state: string;
    source_system?: string;
    acceptance_mode: string;
    created_at: string;
    updated_at: string;
    current_plan_version?: number;
    revision_number?: number;
    authorized_dataset_ids?: string[] | null;
    authorized_capabilities?: string[] | null;
    authorized_mcp_tools?: string[] | null;
  };
  planSummary: PlanSummary | null;
  plans: TaskPlan[];
  nodes: TaskNode[];
  attempts: Attempt[];
  activities: Activity[];
  events?: {
    id?: string;
    instance_id?: string;
    sequence?: number;
    occurred_at?: string;
    payload?: Partial<AssemblyReceipt> & {
      stage?: string;
      step?: number;
      datasetIds?: string[];
    };
  }[];
  workflow?: {
    key: string;
    label: string;
    state: string;
    details?: string[];
  }[];
  artifacts: {
    id: string;
    fileName: string;
    taskNodeId?: string;
    taskAttemptId?: string;
    originalPath?: string;
    mediaType: string;
    revision: number;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  }[];
  acceptanceRounds: Round[];
  currentReviewId?: string | null;
  revisions?: {
    id: string;
    revisionNumber: number;
    decision: "revise" | "amend";
    message: string;
    inputIds: string[];
    reviewId: string | null;
    planVersion: number | null;
    createdAt: string;
  }[];
  inputs?: {
    id: string;
    displayName: string;
    sourceType: string;
    createdAt: string;
  }[];
  interactions?: TaskInteraction[];
  capabilityCalls?: {
    id: string;
    planId: string;
    parentKey: string;
    childKey?: string;
    capability: string;
    reason?: string;
    explanation?: string;
    state: string;
    createdAt: string;
    settledAt?: string;
  }[];
};
export type ResponseField = {
  type: "string" | "boolean" | "number" | "array";
  enum?: (string | boolean | number)[];
  items?: { type: "string" | "number" | "boolean" };
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};
export type TaskInteraction = {
  id: string;
  title: string;
  prompt: string;
  state: string;
  responseSchema?: {
    properties: Record<string, ResponseField>;
    required?: string[];
  };
  answer?: Record<string, unknown>;
  answeredAt?: string;
};
export type TaskTab = "plan" | "quality" | "delivery" | "monitor";
export type TaskLink = { id: string; title: string; tab: TaskTab };
export type FactoryNavigationTarget =
  { kind: "task"; link: TaskLink } | { kind: "new"; scope: TaskScope };
export type OpenTask = (id: string, title: string, tab?: TaskTab) => void;
export type OpenAgent = (agentId: string, version: string) => void;

const states: Record<string, string> = {
  queued: "已排队",
  assembly_preparing: "准备测试",
  dispatching: "正在调用",
  indeterminate: "结果待核对",
  preparing: "准备中",
  simulated_write: "模拟写入",
  received: "已接收",
  planning: "规划中",
  planned: "已编排",
  running: "执行中",
  leasing: "启动中",
  leased: "执行中",
  failed: "失败",
  planning_failed: "规划失败",
  cancelled: "已停止",
  stopping: "停止中",
  interrupted: "已中断",
  awaiting_review: "待人工验收",
  pending_review: "待审核",
  awaiting_user_input: "待补充输入",
  pending: "待处理",
  accepted: "已验收",
  succeeded: "已完成",
  completed: "已完成",
  ready: "已上线",
  offline: "已下线",
  draining: "下线中",
  deleting: "删除中",
  self_check_failed: "自检失败",
  self_checking: "自检中",
  approved: "已审核",
  compiled: "已编排",
  yielded: "等待恢复",
  checking: "核验中",
  assessed: "已评估",
  supplement: "补查",
  rework: "返工",
  revise: "退回重制",
  amend: "补充需求",
  qizhi_local_file: "今日 / 本机文件",
  ragflow_chunk: "知识库片段",
  ragflow_document: "知识库原文",
  uploaded_file: "本地上传",
  accept: "人工通过",
  passed: "通过",
  failed_quality: "未通过",
  uncertain: "待核实",
  unrecorded: "尚无评估",
  met: "已满足",
  missing: "缺项",
  connected: "已连接",
  unavailable: "不可用",
  unconfigured: "未配置",
  not_connected: "未接入",
  available: "入口可用",
  observed: "已记录来源",
  unknown: "来源未记录",
  human_review: "人工验收",
  platform_auto: "平台自动验收",
  human: "人工通过",
  automatic: "自动通过",
  automatic_passed: "自动通过",
  working: "工作中",
  heartbeat: "心跳",
  agent_heartbeat: "智能体心跳",
  agent_progress: "执行进度",
  agent_output: "智能体输出",
  control_plane: "中台",
  node_manager: "节点管理器",
  agent: "智能体",
  qizhi_desktop: "栖知桌面端",
  api: "中台 API",
  feishu: "飞书",
  wechat: "微信",
  wecom: "企业微信",
  email: "邮件",
  business_system: "第三方业务系统",
  native: "本地服务运行时",
  console: "中台控制台",
  cgroup_v2: "Linux cgroup v2",
  finished: "实例已结束",
  unsupported_host: "本机不支持实时采样",
  unverified_unit: "尚未验证运行单元",
  cgroup_unavailable: "运行单元未返回资源数据",
  codex: "Codex 推理运行时",
  codex_exec: "Codex 推理运行时",
  direct_answer: "直接答复",
  stale: "心跳超时",
  expired: "租约已过期",
  ready_for_delivery: "待交付",
};
export const stateName = (value?: string | null) =>
  value ? (states[value] ?? value) : "未记录";
export function statusTone(
  value: string,
): "working" | "review" | "blocked" | "done" | "idle" {
  if (
    [
      "failed",
      "planning_failed",
      "self_check_failed",
      "interrupted",
      "unavailable",
      "stale",
      "expired",
    ].includes(value)
  )
    return "blocked";
  if (
    [
      "pending_review",
      "awaiting_review",
      "awaiting_user_input",
      "pending",
      "checking",
      "uncertain",
      "supplement",
      "rework",
    ].includes(value)
  )
    return "review";
  if (["leased", "leasing", "running", "planning", "working"].includes(value))
    return "working";
  if (
    [
      "accepted",
      "ready",
      "succeeded",
      "completed",
      "connected",
      "passed",
      "met",
      "available",
    ].includes(value)
  )
    return "done";
  return "idle";
}
export function when(value?: string | null, short = false): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未记录";
  return short
    ? date.toLocaleTimeString("zh-CN", { hour12: false })
    : date.toLocaleString("zh-CN", { hour12: false });
}
export function bytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未采集";
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
  if (value < 1024 * 1024 * 1024)
    return (value / 1024 / 1024).toFixed(1) + " MiB";
  return (value / 1024 / 1024 / 1024).toFixed(1) + " GiB";
}
export function activityArea(event: Activity): Area {
  const kind = event.kind;
  if (
    kind.includes("heartbeat") ||
    kind.includes("liveness") ||
    kind.includes("lease_expired")
  )
    return "monitor";
  if (
    kind.includes("accept") ||
    kind.includes("review") ||
    kind.includes("quality") ||
    kind.includes("supplement")
  )
    return "quality";
  if (kind.includes("deliver") || kind.includes("artifact")) return "delivery";
  if (kind.includes("planning") || kind === "direct_answer") return "control";
  if (
    kind.includes("received") ||
    (kind.includes("created") && event.state === "received")
  )
    return "intake";
  if (event.detail?.capability === "knowledge.retrieve") return "assets";
  if (event.source === "node_manager") return "runtime";
  if (event.source === "agent" || kind.includes("node_")) return "line";
  return "monitor";
}
export function activeNode(node: TaskNode) {
  return ["running", "leasing", "leased"].includes(node.state);
}
export function nodeArea(capability?: string): Area {
  if (capability === "knowledge.retrieve") return "assets";
  if (capability?.startsWith("quality.")) return "quality";
  return "line";
}

// Desktop and browser transports both expose the control plane's documented error text.
// Keep the wire reasons intact and present them in the terms used by the studio.
const assemblyMessages = new Map([
  [
    "已封存候选源码、资源及用例。",
    "智能体已生成，代码、资源和测试用例已保存。",
  ],
  ["正在隔离环境逐项运行候选固定用例。", "正在逐项运行智能体的固定测试。"],
  ["用户已停止试跑", "用户已停止测试。"],
  [
    "草稿已有更新，请刷新后再保存。",
    "当前版本的编辑内容已更新，请重新读取后再保存。",
  ],
  [
    "样例参数与候选的输入约定不匹配。",
    "样例参数与这次生成的智能体所需输入不匹配。",
  ],
  [
    "样例仍有未获证实的必需条件，请查看工单逐项验收并重新试跑。",
    "仍有必需的验收条件待验证，请查看工单的逐项结果并重新测试。",
  ],
  ["试跑记录与所选候选快照不匹配。", "这份测试结果与所选生成记录不匹配。"],
  ["该版本已绑定其他候选或试跑。", "这个版本已绑定其他生成记录或测试结果。"],
  [
    "样例工单需完成验收，并由装配者认可此次试跑。",
    "请完成样例工单验收，并在测试记录中认可结果。",
  ],
  [
    "请先停止该草稿仍在执行的操作或试跑。",
    "请先停止此版本正在执行的操作或测试。",
  ],
  ["试跑尚未完成。", "测试尚未完成。"],
  [
    "运行环境已变化，请重新生成并试跑。",
    "运行环境已变化，请重新生成并测试智能体。",
  ],
]);

export function errorText(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string" && error
        ? error
        : "无法读取中台响应";
  return factoryMessage(message);
}

export function factoryMessage(message: string) {
  const suffix = message.indexOf("（HTTP ");
  const reason = suffix === -1 ? message : message.slice(0, suffix);
  const copy = assemblyMessages.get(reason);
  return copy ? copy + message.slice(reason.length) : message;
}
