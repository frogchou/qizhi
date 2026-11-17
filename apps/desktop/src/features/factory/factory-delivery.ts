import type { TaskDelivery, TaskDetail, TaskNode } from "./factory-model";

const text = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value : "";

function currentPlan(detail: TaskDetail) {
  const revision = detail.revisions?.find(
    (item) => item.revisionNumber === (detail.task.revision_number ?? 0),
  );
  // During replanning current_plan_version still points at the prior revision.
  if (revision && revision.planVersion === null) return undefined;
  const version = revision?.planVersion ?? detail.task.current_plan_version;
  return version !== undefined
    ? detail.plans.find((plan) => plan.version === version)
    : [...detail.plans].sort((a, b) => b.version - a.version)[0];
}

function fullNodeBody(node: TaskNode): string {
  const output = node.output?.output;
  const full = text(output?.answer) || text(output?.text);
  if (full) return full;
  return (output?.findings ?? [])
    .map((finding) => {
      const message = text(finding.message);
      if (!message) return "";
      const title = text(finding.title);
      return title ? "### " + title + "\n\n" + message : message;
    })
    .filter(Boolean)
    .join("\n\n");
}

function deliveryNodes(
  detail: TaskDetail,
  nodes: TaskNode[],
  reviewed: Set<string>,
): TaskNode[] {
  const plan = currentPlan(detail);
  const specs = new Map(plan?.plan.nodes?.map((node) => [node.id, node]) ?? []);
  const successful = nodes.filter(
    (node) =>
      ["succeeded", "completed", "accepted"].includes(node.state) &&
      specs.get(node.node_key)?.type !== "end",
  );
  const quality = successful.filter((node) =>
    node.capability?.startsWith("quality."),
  );
  const producers = successful.filter(
    (node) => !node.capability?.startsWith("quality."),
  );
  // A quality check consumes an answer for review, but does not replace that answer.
  const consumed = new Set(
    producers.flatMap(
      (node) => node.depends_on ?? specs.get(node.node_key)?.dependsOn ?? [],
    ),
  );
  const leaves = producers.filter((node) => !consumed.has(node.node_key));
  const substantive = leaves.filter(
    (node) => node.capability !== "knowledge.retrieve",
  );
  if (
    substantive.some(
      (node) =>
        fullNodeBody(node) ||
        reviewed.has(node.node_key) ||
        detail.artifacts.some((artifact) => artifact.taskNodeId === node.id),
    )
  )
    return substantive;
  // Legacy document analysis may itself have been carried out by the quality agent.
  if (quality.some((node) => fullNodeBody(node) || reviewed.has(node.node_key)))
    return quality;
  return leaves.length ? leaves : quality;
}
function uniqueAnswers(answers: TaskDelivery["answers"]) {
  const seen = new Set<string>();
  return answers.filter((answer) => {
    const body = text(answer.body);
    if (!body || seen.has(body)) return false;
    seen.add(body);
    return true;
  });
}

/** Prefer the server's current-revision delivery, including an explicit empty result. */
export function taskDelivery(detail: TaskDetail): TaskDelivery {
  const revisionNumber = detail.task.revision_number ?? 0;
  const empty: TaskDelivery = {
    revisionNumber,
    answers: [],
    artifactIds: [],
    supportingArtifactIds: [],
  };
  if (detail.delivery !== undefined) {
    if (detail.delivery.revisionNumber !== revisionNumber) return empty;
    return {
      ...detail.delivery,
      answers: uniqueAnswers(detail.delivery.answers),
    };
  }

  const revision = detail.revisions?.find(
    (item) => item.revisionNumber === revisionNumber,
  );
  if (revision && revision.planVersion === null) return empty;
  const plan = currentPlan(detail);
  const nodes = detail.nodes.filter((node) => node.plan_id === plan?.id);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rounds = detail.acceptanceRounds
    .filter((round) => (round.revision_number ?? 0) === revisionNumber)
    .sort((a, b) => b.round - a.round);
  const latest =
    detail.currentReviewId === undefined
      ? rounds[0]
      : rounds.find((round) => round.id === detail.currentReviewId);
  const selected = deliveryNodes(
    detail,
    nodes,
    new Set(
      (latest?.assessment?.deliveries ?? [])
        .filter((entry) => text(entry.answer))
        .map((entry) => entry.node),
    ),
  );
  const byKey = new Map(selected.map((node) => [node.node_key, node]));
  const answers: TaskDelivery["answers"] = [];
  const answered = new Set<string>();
  const add = (nodeKey: string, title: string, body: string) => {
    if (!body || answered.has(nodeKey)) return;
    answered.add(nodeKey);
    answers.push({ nodeKey, title, body, format: "markdown" });
  };
  const summary = plan?.plan.planner ?? detail.planSummary;
  if (summary?.mode === "direct_answer")
    add("direct_answer", "中台答复", text(summary.summary));

  for (const node of selected) {
    add(node.node_key, node.display_title || node.node_key, fullNodeBody(node));
  }
  for (const delivery of latest?.assessment?.deliveries ?? []) {
    const node = byKey.get(delivery.node);
    if (node)
      add(
        node.node_key,
        node.display_title || node.node_key,
        text(delivery.answer),
      );
  }
  // A procedural summary must not compete with a complete answer or findings.
  if (!answers.length) {
    for (const node of selected) {
      const output = node.output?.output;
      add(
        node.node_key,
        node.display_title || node.node_key,
        text(output?.summary) || text(output?.message),
      );
    }
  }

  const artifacts = new Map<string, TaskDetail["artifacts"][number]>();
  for (const artifact of detail.artifacts) {
    if (artifact.taskNodeId && !byId.has(artifact.taskNodeId)) continue;
    const key =
      (artifact.taskNodeId ?? "") +
      ":" +
      (artifact.originalPath ?? artifact.fileName);
    const previous = artifacts.get(key);
    if (!previous || artifact.revision > previous.revision)
      artifacts.set(key, artifact);
  }
  const artifactIds: string[] = [];
  const supportingArtifactIds: string[] = [];
  for (const artifact of artifacts.values()) {
    const source = artifact.taskNodeId
      ? byId.get(artifact.taskNodeId)
      : undefined;
    const name = artifact.originalPath ?? artifact.fileName;
    const isQualityReport =
      source?.capability === "quality.define_and_verify" &&
      ["acceptance-criteria.json", "quality-assessment.json"].includes(name);
    (isQualityReport ? supportingArtifactIds : artifactIds).push(artifact.id);
  }
  return {
    revisionNumber,
    answers: uniqueAnswers(answers),
    artifactIds,
    supportingArtifactIds,
  };
}
