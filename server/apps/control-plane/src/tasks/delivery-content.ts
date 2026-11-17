/** The user-facing result projection. Full result bodies are never replaced by execution acknowledgements. */
export type DeliveryResultNode = {
  nodeKey: string; capability: string | null; output: Record<string, unknown> | null; dependsOn?: string[];
};
export type TaskDelivery = {
  revisionNumber: number;
  answers: Array<{ nodeKey: string; title: string; body: string; format: 'markdown' | 'text' }>;
  artifactIds: string[];
  supportingArtifactIds: string[];
};
type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(object) : [];
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const strings = (v: unknown): string[] => Array.isArray(v) ? v.map(text).filter(Boolean) : [];
const quality = (node: DeliveryResultNode) => node.capability?.startsWith('quality.') === true;

export function nodeAnswer(node: DeliveryResultNode): string {
  if (node.output?.status === 'failed') return '';
  const data = object(node.output?.output);
  for (const key of ['answer', 'text']) if (text(data[key])) return text(data[key]);
  // Older review-only plans put the requested analysis in findings. Recover the
  // actual messages without rerunning the agent or changing historical results.
  const findings = rows(data.findings).filter(f => text(f.message));
  if (findings.length) return findings.map((f, i) => {
    const location = text(f.path) || text(f.title);
    return `### ${i + 1}. ${location || '分析结论'}\n\n${text(f.message)}`;
  }).join('\n\n');
  return text(data.summary) || text(data.message);
}

export function selectDeliveryNodes<T extends DeliveryResultNode>(nodes: T[]): T[] {
  const available = nodes.filter(n => n.output?.status !== 'failed' && (nodeAnswer(n) || rows(n.output?.artifacts).length));
  const hasReviewAnalysis = available.some(n => quality(n) && rows(object(n.output?.output).findings).length > 0);
  const producers = available.filter(n => !quality(n) && !(hasReviewAnalysis && n.capability === 'knowledge.retrieve'));
  const candidates = producers.length ? producers : available;
  const byKey = new Map(nodes.map(n => [n.nodeKey, n]));
  const consumed = new Set<string>();
  const visit = (key: string, seen: Set<string>) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const parent of byKey.get(key)?.dependsOn ?? []) { consumed.add(parent); visit(parent, seen); }
  };
  for (const node of candidates) visit(node.nodeKey, new Set());
  return candidates.filter(n => !consumed.has(n.nodeKey));
}

export function primaryArtifactPaths(node: DeliveryResultNode): string[] {
  const data = object(node.output?.output);
  const declared = rows(node.output?.artifacts).map(a => text(a.path)).filter(Boolean);
  if (Array.isArray(data.deliveryArtifactPaths)) return strings(data.deliveryArtifactPaths).filter(p => declared.includes(p));
  return declared.filter(p => !(quality(node) && ['acceptance-criteria.json', 'quality-assessment.json'].includes(p.replaceAll('\\', '/').split('/').at(-1)!)));
}

export function buildTaskDelivery(input: { task: Row; plans: Row[]; nodes: Row[]; artifacts: Row[]; revisions?: Row[]; acceptanceRounds?: Row[] }): TaskDelivery {
  const { task } = input;
  const revisionNumber = Number(task.revision_number ?? task.revisionNumber ?? 0);
  const delivery: TaskDelivery = { revisionNumber, answers: [], artifactIds: [], supportingArtifactIds: [] };
  const revision = input.revisions?.find(r => Number(r.revisionNumber ?? r.revision_number) === revisionNumber);
  // An amendment retains the old plan pointer until compilation commits. Never
  // serve that previous delivery as the result of the new pending revision.
  if (revisionNumber > 0 && (!revision || (revision.planVersion ?? revision.plan_version) == null)) return delivery;
  const version = revisionNumber > 0 ? Number(revision!.planVersion ?? revision!.plan_version)
    : Number(task.current_plan_version ?? task.planVersion ?? Math.max(0, ...input.plans.map(p => Number(p.version))));
  const plan = input.plans.find(p => Number(p.version) === version);
  const current = input.nodes.filter(n => plan && (n.plan_id ?? n.planId) === plan.id)
    .filter(n => (!n.state || n.state === 'completed') && object(n.output).status !== 'failed');
  const normalized = current.map(n => ({ id: text(n.id), nodeKey: text(n.node_key ?? n.nodeKey),
    capability: text(n.capability) || null, output: object(n.output), dependsOn: strings(n.depends_on ?? n.dependsOn) }));
  const selected = selectDeliveryNodes(normalized);
  const titles: Record<string, string> = { 'document.analyze': '文件分析与用途说明', 'quality.define_and_verify': '文档分析与审阅结论',
    'presentation.create': '演示文稿', 'web.research': '资料研究', 'knowledge.retrieve': '知识检索结果' };
  for (const node of selected) {
    const body = nodeAnswer(node);
    if (body) delivery.answers.push({ nodeKey: node.nodeKey, title: titles[node.capability ?? ''] ?? node.nodeKey, body, format: 'markdown' });
  }
  const latestFiles = new Map<string, Row>();
  for (const file of input.artifacts) {
    const nodeId = text(file.taskNodeId ?? file.task_node_id);
    const node = normalized.find(n => n.id === nodeId);
    if (!node) continue;
    const path = text(file.originalPath ?? file.original_path);
    const declarations = rows(node.output.artifacts);
    if (!declarations.some(a => text(a.path) === path && text(a.sha256) === text(file.sha256))) continue;
    const key = nodeId + '\0' + path;
    const previous = latestFiles.get(key);
    if (!previous || Number(file.revision) > Number(previous.revision)) latestFiles.set(key, file);
  }
  for (const file of latestFiles.values()) {
    const node = selected.find(n => n.id === (file.taskNodeId ?? file.task_node_id));
    const primary = node && primaryArtifactPaths(node).includes(text(file.originalPath ?? file.original_path));
    (primary ? delivery.artifactIds : delivery.supportingArtifactIds).push(text(file.id));
  }
  const planner = object(task.planner_summary ?? task.planSummary);
  if (!delivery.answers.length && !normalized.length && planner.mode === 'direct_answer' && text(planner.summary)) {
    delivery.answers.push({ nodeKey: 'control_plane.answer', title: '任务答复', body: text(planner.summary), format: 'markdown' });
  }
  // Compatibility for old direct deliveries with only a persisted acceptance
  // snapshot. Current node results always take precedence over this snapshot.
  if (!delivery.answers.length && !normalized.length && ['accepted', 'awaiting_review'].includes(text(task.state))) {
    const round = input.acceptanceRounds?.filter(r => Number(r.revision_number ?? r.revisionNumber ?? 0) === revisionNumber)
      .sort((a, b) => Number(a.round) - Number(b.round)).at(-1);
    for (const item of rows(object(round?.assessment).deliveries)) if (text(item.answer))
      delivery.answers.push({ nodeKey: text(item.node) || 'answer', title: '任务成果', body: text(item.answer), format: 'markdown' });
  }
  return delivery;
}
