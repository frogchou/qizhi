import type { Area } from "./simulation";

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
export type ManagedPackage = {
  packageName: string;
  agentId: string;
  version: string;
  displayName: string;
  status: string | null;
  declared: boolean;
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
  };
  planSummary: PlanSummary | null;
  plans: TaskPlan[];
  nodes: TaskNode[];
  attempts: Attempt[];
  activities: Activity[];
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
  interactions?: { id: string; title: string; prompt: string; state: string }[];
};
export type TaskTab = "plan" | "quality" | "delivery" | "monitor";
export type TaskLink = { id: string; title: string; tab: TaskTab };
export type OpenTask = (id: string, title: string, tab?: TaskTab) => void;
export type OpenAgent = (agentId: string, version: string) => void;

const states: Record<string, string> = {
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
export function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "string" && error
      ? error
      : "无法读取中台响应";
}
