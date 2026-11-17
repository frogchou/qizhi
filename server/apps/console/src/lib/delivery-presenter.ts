type Row = Record<string, unknown>;

export type DeliveryAnswer = { nodeKey: string; title: string; body: string; format: 'markdown' | 'text' };
export type TaskDelivery = { revisionNumber: number; answers: DeliveryAnswer[]; artifactIds: string[]; supportingArtifactIds: string[] };
export type PresentedAnswer = DeliveryAnswer & { sources?: Array<{ id: string; title: string; url: string }> };
export type PresentedArtifact = { id: string; fileName: string; mediaType: string; revision: number; createdAt: string; sizeBytes: number };
export type DeliveryDetail = {
  task?: Row; planSummary?: unknown; plans?: Row[]; revisions?: Row[]; nodes?: Row[]; artifacts?: Row[]; delivery?: unknown;
};

/** Delivery is an API projection; only older responses need node-output recovery. */
export function presentDelivery(detail: DeliveryDetail): { answers: PresentedAnswer[]; artifacts: PresentedArtifact[]; supportingArtifacts: PresentedArtifact[] } {
  const nodes = currentTaskNodes(detail);
  const artifacts = (detail.artifacts ?? []).filter(item => text(item.id) && text(item.fileName));
  if (detail.delivery !== undefined) {
    const delivery = object(detail.delivery);
    const artifactIds = new Set(array(delivery.artifactIds).map(text));
    const supportingIds = new Set(array(delivery.supportingArtifactIds).map(text));
    return {
      answers: array(delivery.answers).map(object).filter(answer => text(answer.body).trim()).map(answer => withSources({
        nodeKey: text(answer.nodeKey), title: text(answer.title) || '任务答复', body: text(answer.body), format: answer.format === 'text' ? 'text' : 'markdown',
      }, nodes)),
      artifacts: artifacts.filter(item => artifactIds.has(text(item.id))).map(presentArtifact),
      supportingArtifacts: artifacts.filter(item => supportingIds.has(text(item.id)) && !artifactIds.has(text(item.id))).map(presentArtifact),
    };
  }

  if (awaitingRevisionPlan(detail)) return { answers: [], artifacts: [], supportingArtifacts: [] };
  const nodeIds = new Set(nodes.map(node => text(node.id)));
  const currentArtifacts = latestArtifacts(artifacts.filter(item => !text(item.taskNodeId) || nodeIds.has(text(item.taskNodeId))));
  const available = nodes.filter(node => successful(node) && (legacyAnswer(node, nodes).length || currentArtifacts.some(artifact => text(artifact.taskNodeId) === text(node.id))));
  const hasReviewAnalysis = available.some(node => isQuality(node) && !!structuredAnalysis(object(object(node.output).output)));
  const producers = available.filter(node => !isQuality(node) && !(hasReviewAnalysis && node.capability === 'knowledge.retrieve'));
  const candidates = producers.length ? producers : available;
  const consumedNodes = new Set<string>();
  const byKey = new Map(nodes.map(node => [text(node.node_key), node]));
  const visit = (key: string, visited: Set<string>) => {
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of array(byKey.get(key)?.depends_on).map(text)) { consumedNodes.add(dependency); visit(dependency, visited); }
  };
  for (const node of candidates) visit(text(node.node_key), new Set());
  const selected = candidates.filter(node => !consumedNodes.has(text(node.node_key)));
  const selectedIds = new Set(selected.map(node => text(node.id)));
  const answers = selected.flatMap(node => legacyAnswer(node, nodes));
  const summary = object(detail.planSummary);
  if (!answers.length && !nodes.length && summary.mode === 'direct_answer' && text(summary.summary).trim()) {
    answers.push({ nodeKey: 'direct-answer', title: '中台答复', body: text(summary.summary), format: 'markdown' });
  }
  const supporting = (artifact: Row) => {
    const node = nodes.find(row => text(row.id) === text(artifact.taskNodeId));
    if (!node) return false;
    const explicitPaths = object(object(node.output).output).deliveryArtifactPaths;
    if (Array.isArray(explicitPaths) && selectedIds.has(text(node.id))) return !explicitPaths.includes(text(artifact.originalPath));
    const processReport = isQuality(node) &&
      /^(quality-assessment|acceptance-criteria)\.json$/i.test(text(artifact.fileName));
    return processReport || !selectedIds.has(text(node.id));
  };
  return {
    answers,
    artifacts: currentArtifacts.filter(item => !supporting(item)).map(presentArtifact),
    supportingArtifacts: currentArtifacts.filter(supporting).map(presentArtifact),
  };
}

function legacyAnswer(node: Row, nodes: Row[]): PresentedAnswer[] {
  const data = object(object(node.output).output);
  const body = text(data.answer).trim() || text(data.text).trim() || structuredAnalysis(data) || text(data.summary).trim() || text(data.message).trim();
  return body ? [withSources({ nodeKey: text(node.node_key), title: text(node.display_title) || text(node.node_key) || '任务答复', body, format: 'markdown' }, nodes)] : [];
}
function isQuality(node: Row): boolean { return node.capability === 'quality.define_and_verify' || node.agent_id === 'quality-management'; }
function successful(node: Row): boolean { return ['completed', 'succeeded', 'accepted'].includes(text(node.state)) && object(node.output).status !== 'failed'; }

export function currentTaskNodes(detail: DeliveryDetail): Row[] {
  if (awaitingRevisionPlan(detail)) return [];
  const task = detail.task ?? {};
  const revision = currentRevision(detail);
  const version = revision ? revision.planVersion ?? revision.plan_version : task.current_plan_version ?? task.currentPlanVersion;
  const plans = detail.plans ?? [];
  const plan = version === undefined || version === null
    ? [...plans].sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0]
    : plans.find(item => Number(item.version) === Number(version));
  const nodes = detail.nodes ?? [];
  if (version !== undefined && version !== null && plans.length && !plan) return [];
  return text(plan?.id) && nodes.some(node => text(node.plan_id)) ? nodes.filter(node => text(node.plan_id) === text(plan?.id)) : nodes;
}

function currentRevision(detail: DeliveryDetail): Row | undefined {
  const task = detail.task ?? {};
  const number = Number(task.revision_number ?? task.revisionNumber ?? 1);
  return (detail.revisions ?? []).find(revision => Number(revision.revisionNumber ?? revision.revision_number) === number);
}
function awaitingRevisionPlan(detail: DeliveryDetail): boolean {
  const revision = currentRevision(detail);
  const revisionNumber = Number(detail.task?.revision_number ?? detail.task?.revisionNumber ?? 0);
  if (detail.revisions !== undefined && revisionNumber > 0 && !revision) return true;
  return !!revision && !(Number(revision.planVersion ?? revision.plan_version) > 0);
}
function structuredAnalysis(data: Row): string {
  const findings = array(data.findings).flatMap((value, index) => {
    const finding = object(value);
    const message = typeof value === 'string' ? value : text(finding.message) || text(finding.text) || text(finding.description);
    if (!message.trim()) return [];
    const metadata = [text(finding.severity) && `级别：${severityName(text(finding.severity))}`, text(finding.path) && `涉及文件：${text(finding.path)}`].filter(Boolean);
    return [`### ${text(finding.title) || `发现 ${index + 1}`}\n\n${metadata.length ? `${metadata.join(' · ')}\n\n` : ''}${message}`];
  });
  if (!findings.length) return '';
  const criteria = array(data.criteria).flatMap(value => {
    const criterion = object(value);
    const description = typeof value === 'string' ? value : text(criterion.criterion) || text(criterion.requirement);
    return description.trim() ? [`- ${description}${text(criterion.method) ? `（核验方法：${text(criterion.method)}）` : ''}`] : [];
  });
  return [text(data.summary), '## 分析发现', ...findings, ...(criteria.length ? ['## 核验依据', criteria.join('\n')] : [])].filter(Boolean).join('\n\n');
}
function severityName(value: string): string {
  return ({ critical: '严重', error: '错误', high: '高', medium: '中', low: '低', warning: '需注意', info: '说明' } as Record<string, string>)[value] ?? value;
}
function withSources(answer: DeliveryAnswer, nodes: Row[]): PresentedAnswer {
  const node = nodes.find(item => text(item.node_key) === answer.nodeKey && item.capability === 'research.web');
  const sources = array(object(object(node?.output).output).sources).map(object).map(source => ({ id: text(source.id), title: text(source.title), url: text(source.url) })).filter(source => /^https?:\/\//i.test(source.url));
  return sources.length ? { ...answer, sources } : answer;
}
function latestArtifacts(artifacts: Row[]): Row[] {
  const latest = new Map<string, Row>();
  for (const artifact of artifacts) {
    const key = text(artifact.taskNodeId) ? `${text(artifact.taskNodeId)}/${text(artifact.originalPath) || text(artifact.fileName)}` : text(artifact.id);
    const previous = latest.get(key);
    if (!previous || Number(artifact.revision) > Number(previous.revision)) latest.set(key, artifact);
  }
  return [...latest.values()];
}
function presentArtifact(item: Row): PresentedArtifact {
  return { id: text(item.id), fileName: text(item.fileName), mediaType: text(item.mediaType), revision: Number(item.revision) || 1, createdAt: text(item.createdAt), sizeBytes: Number(item.sizeBytes) || 0 };
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
