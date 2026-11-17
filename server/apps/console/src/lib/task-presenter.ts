import type { WorkflowStage } from './workflow';
import { currentTaskNodes, presentDelivery, type DeliveryDetail, type PresentedAnswer, type PresentedArtifact } from './delivery-presenter';

type Row = Record<string, unknown>;

export type PresentedNode = {
  id: string;
  key: string;
  title: string;
  capability: string;
  reason: string;
  runtime: string;
  state: string;
  stateLabel: string;
  duration: string;
  health: string;
  startedAt?: string;
  summary: string;
  artifacts: string[];
  evidence: string[];
  research?: { summary: string; coverage: string; sources: Array<{id:string; title:string; url:string}> };
};

export type PresentedActivity = {
  id: string;
  kind: string;
  state: string;
  message: string;
  source: string;
  occurredAt: string;
  detail: Row;
};

export type TaskPresentation = {
  title: string;
  state: string;
  stateLabel: string;
  intent: string;
  summary: string;
  deliverables: string[];
  risks: string[];
  stages: WorkflowStage[];
  nodes: PresentedNode[];
  activities: PresentedActivity[];
  answers: PresentedAnswer[];
  artifacts: PresentedArtifact[];
  supportingArtifacts: PresentedArtifact[];
  inputs: Array<{ id: string; displayName: string; originalFilename: string; sourceType: string; mediaType: string; sizeBytes: number; sha256: string; createdAt: string }>;
  interactions: Array<{ id: string; source: string; kind: string; title: string; prompt: string; responseSchema: Row; state: string; requestedAt: string }>;
  quality: { state: string; summary: string; passed?: boolean } | null;
  consoleEntries: Array<{ id: string; occurredAt: string; source: string; message: string; text?: string; state: string }>;
  debug: { activities: PresentedActivity[]; events: Row[]; attempts: Row[]; nodeResults: Array<{ key: string; output: unknown }> };
};

/** Converts durable relational rows into the concise Chinese operator view. */
export function presentTask(detail: DeliveryDetail & { attempts?: Row[]; events?: Row[]; activities?: Row[]; inputs?: Row[]; interactions?: Row[]; workflow?: WorkflowStage[] }, now = Date.now()): TaskPresentation {
  const task = detail.task ?? {};
  const planSummary = object(detail.planSummary);
  const plan = object(object((detail.plans ?? [])[0]).plan);
  const reasons = object(plan.nodeReasons);
  const attempts = detail.attempts ?? [];
  const events = detail.events ?? [];
  const activities = (detail.activities ?? []).map((activity) => ({
    id: text(activity.id) || String(activity.id ?? ''), kind: text(activity.kind), state: text(activity.state) || 'pending', message: text(activity.message) || '任务状态已更新。',
    source: text(activity.source) || 'control_plane', occurredAt: text(activity.occurredAt) || text(activity.occurred_at), detail: object(activity.detail),
  })).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  const nodes = (detail.nodes ?? []).map((node) => {
    const id = text(node.id);
    const key = text(node.node_key);
    const capability = text(node.capability);
    const output = object(node.output);
    const attempt = attempts.filter((item) => text(item.task_node_id) === id).sort((left, right) => Date.parse(text(left.created_at)) - Date.parse(text(right.created_at))).at(-1);
    const nodeEvents = attempt ? events.filter((event) => text(event.instance_id) === text(attempt.instance_id)) : [];
    const evidence = array(output.evidence).map(evidenceTitle).filter(Boolean);
    const artifacts = array(output.artifacts).map((item) => text(object(item).path)).filter(Boolean);
    const data = object(output.output);
    const research = capability === 'research.web' && text(data.summary) ? {
      summary: text(data.summary), coverage: text(data.coverage),
      sources: array(data.sources).map(object).map(s => ({ id:text(s.id), title:text(s.title), url:text(s.url) })).filter(s => /^https:\/\//i.test(s.url)),
    } : undefined;
    return {
      id, key, capability, title: text(node.display_title) || titleFor(capability, key), reason: text(node.rationale) || text(reasons[key]) || '中台已选择该能力处理此节点。',
      research, runtime: runtimeFor(capability, text(node.agent_version)), state: text(node.state) || 'pending', stateLabel: stateName(text(node.state) || 'pending'),
      duration: duration(attempt?.created_at ?? node.created_at, node.updated_at, text(node.state), now),
      health: health(attempt, text(node.state), now, nodeEvents), startedAt: text(attempt?.created_at ?? node.created_at) || undefined,
      summary: nodeSummary(capability, output, nodeEvents), artifacts, evidence,
    } satisfies PresentedNode;
  });
  const currentQuality = currentTaskNodes(detail).find((node) => text(node.capability) === 'quality.define_and_verify');
  const qualityNode = nodes.find((node) => node.id === text(currentQuality?.id));
  const qualityOutput = object(currentQuality?.output);
  const qualityData = object(qualityOutput.output);
  return {
    title: text(task.goal) || '未命名任务', state: text(task.state) || 'pending', stateLabel: stateName(text(task.state) || 'pending'),
    intent: text(planSummary.intent) || (['cancelled','stopping'].includes(text(task.state)) ? '管理员请求停止任务。' : '正在等待中台完成意图分析。'),
    summary: text(planSummary.summary) || (['cancelled','stopping'].includes(text(task.state)) ? '' : '任务计划尚未生成。'),
    deliverables: array(planSummary.deliverables).map(text).filter(Boolean), risks: array(planSummary.risks).map(text).filter(Boolean),
    stages: detail.workflow ?? [], nodes, activities, ...presentDelivery(detail),
    inputs: (detail.inputs ?? []).map((item) => object(item)).filter((item) => text(item.id) && text(item.displayName)).map((item) => ({ id: text(item.id), displayName: text(item.displayName), originalFilename: text(item.originalFilename), sourceType: text(item.sourceType), mediaType: text(item.mediaType), sizeBytes: Number(item.sizeBytes) || 0, sha256: text(item.sha256), createdAt: text(item.createdAt) })),
    interactions: (detail.interactions ?? []).map(object).filter((item) => text(item.id)).map((item) => ({ id: text(item.id), source: text(item.source), kind: text(item.kind), title: text(item.title), prompt: text(item.prompt), responseSchema: object(item.responseSchema), state: text(item.state), requestedAt: text(item.requestedAt) })),
    quality: qualityNode ? { state: qualityNode.state, summary: text(qualityData.summary) || qualityNode.summary, passed: typeof qualityData.passed === 'boolean' ? qualityData.passed : undefined } : null,
    consoleEntries: consoleEntries(activities, events),
    debug: { activities, events, attempts, nodeResults: nodes.map((node) => ({ key: node.key, output: (detail.nodes ?? []).find((row) => text(row.id) === node.id)?.output })) },
  };
}

export function stateName(state: string): string {
  return ({ received: '已接收', planning: '分析中', planned: '已编排', running: '执行中', leased: '执行中', completed: '已完成', succeeded: '已完成', accepted: '已验收', pending: '等待中', leasing: '启动中', failed: '失败', planning_failed: '规划失败', awaiting_review: '待人工验收', awaiting_user_input: '等待你的输入', pending_review: '待审批', ready: '就绪', interrupted: '已中断', yielded: '等待恢复', stopping: '正在停止', cancelled: '已停止' } as Record<string, string>)[state] ?? state;
}

export function stateTone(state: string): 'success' | 'active' | 'warning' | 'danger' | 'neutral' {
  if (['accepted', 'completed', 'succeeded', 'ready'].includes(state)) return 'success';
  if (['running', 'leased', 'planning', 'leasing'].includes(state)) return 'active';
  if (['awaiting_review', 'awaiting_user_input', 'pending_review', 'pending', 'interrupted', 'yielded'].includes(state)) return 'warning';
  if (['failed', 'planning_failed'].includes(state)) return 'danger';
  return 'neutral';
}

function titleFor(capability: string, key: string): string {
  return ({ 'knowledge.retrieve': '知识库检索', 'research.web': '互联网资料收集', 'presentation.create': 'PPT 制作', 'quality.define_and_verify': '质量与验收' } as Record<string, string>)[capability] ?? key;
}
function runtimeFor(capability: string, version: string): string {
  const codex = ['presentation.create', 'quality.define_and_verify'].includes(capability) || (capability === 'research.web' && Number(version.split('.')[0]) >= 2);
  return codex ? 'Codex 运行时' : '原生运行时';
}
function nodeSummary(capability: string, output: Row, events: Row[]): string {
  const event = object(events.at(-1)?.payload);
  if (capability === 'research.web') {
    const data = object(output.output);
    if (text(data.coverage)) return data.coverage === 'insufficient' ? '未取得可验证资料' : '已完成来源核验，答复见研究结果';
    if (text(data.message)) return text(data.message);
    const last = [...events].filter(e=>e.event_type === 'progress').sort((a,b)=>Number(b.sequence)-Number(a.sequence))[0];
    if (last) return text(object(last.payload).stage);
  }
  const stage = text(event.stage);
  const evidence = array(output.evidence);
  const artifacts = array(output.artifacts);
  if (capability === 'knowledge.retrieve' && evidence.length) return `已收集 ${evidence.length} 条可追溯知识证据：${evidence.map(evidenceTitle).filter(Boolean).join('、')}。`;
  if (capability === 'presentation.create' && artifacts.length) return `已生成 ${artifacts.map((item) => text(object(item).path)).filter(Boolean).join('、')}。`;
  if (capability === 'quality.define_and_verify' && typeof object(output.output).passed === 'boolean') return object(output.output).passed === true ? '质量验收已通过。' : '质量验收未通过，正在等待返工或人工决定。';
  if (text(event.runtime) === 'codex' && ['started', 'running'].includes(text(event.state))) return `Codex 进程仍在执行；${codexLiveness(event)}`;
  if (stage) return stage.replaceAll('_', ' · ');
  return '等待智能体返回新的进度信息。';
}
function duration(start: unknown, end: unknown, state: string, now: number): string {
  const startTime = Date.parse(text(start)); const endTime = Date.parse(text(end));
  if (!Number.isFinite(startTime)) return '—';
  const milliseconds = ['running', 'leased', 'leasing'].includes(state) ? Math.max(0, now - startTime) : Math.max(0, endTime - startTime);
  return humanDuration(milliseconds);
}
function health(attempt: Row | undefined, state: string, now: number, events: Row[]): string {
  if (!['running', 'leased', 'leasing'].includes(state)) return '无需持续监督';
  if (!attempt) return '等待中台分配运行实例';
  const latestCodexStatus = [...events].reverse().map((event) => object(event.payload)).find((payload) => text(payload.runtime) === 'codex' && ['started', 'running'].includes(text(payload.state)));
  if (latestCodexStatus) return `Codex 进程仍在运行 · ${codexLiveness(latestCodexStatus)}`;
  const heartbeatAt = Date.parse(text(attempt.last_heartbeat_at));
  if (!Number.isFinite(heartbeatAt)) return '中台正在等待首次心跳';
  return `中台已确认存活 · 最近心跳 ${humanDuration(Math.max(0, now - heartbeatAt))}前`;
}
function codexLiveness(payload: Row): string {
  const parts: string[] = [];
  const elapsedMs = numberValue(payload.elapsedMs);
  if (elapsedMs !== undefined) parts.push(`已运行 ${humanDuration(elapsedMs)}`);
  const lastOutputAgeMs = numberValue(payload.lastOutputAgeMs);
  if (lastOutputAgeMs !== undefined) parts.push(`最近输出 ${humanDuration(lastOutputAgeMs)}前`);
  else if (payload.outputReceived === false) parts.push('尚未收到输出');
  return parts.join(' · ') || '中台正在确认运行状态';
}
function consoleEntries(activities: PresentedActivity[], events: Row[]): Array<{ id: string; occurredAt: string; source: string; message: string; text?: string; state: string }> {
  const activitiesWithoutMirroredOutput = activities.filter((activity) => activity.kind !== 'agent_output').map((activity) => ({
    id: `activity-${activity.id}`, occurredAt: activity.occurredAt, source: activity.source, message: activity.message, state: activity.state,
  }));
  const outputs = events.filter((event) => text(event.event_type) === 'output').map((event, index) => {
    const payload = object(event.payload);
    return { id: `output-${text(event.instance_id)}-${text(event.sequence) || index}`, occurredAt: text(event.occurred_at), source: 'agent', message: `运行输出 · ${text(payload.stream) || 'stdout'}`, text: text(payload.text) || text(payload.chunk), state: 'running' };
  });
  return [...activitiesWithoutMirroredOutput, ...outputs].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
}
function humanDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}
function evidenceTitle(value: unknown): string { const evidence = object(value); return text(evidence.title) || text(evidence.source) || text(evidence.excerpt).slice(0, 36); }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
