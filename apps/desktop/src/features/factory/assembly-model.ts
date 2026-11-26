import { useRef } from "react";
import type { SkillFile } from "./skill-files";
import {
  stateName,
  when,
  type Agent,
  type AssemblyReceipt,
} from "./factory-model";
import { factoryApi } from "./factory-client";

export const assemblies = "/v1/factory/assemblies";
export const resources = "/v1/factory/assembly-resources";
export const draftPath = (id: string) =>
  `${assemblies}/${encodeURIComponent(id)}` as const;

export type TaskScope = {
  capabilities: string[];
  datasetIds: string[];
  mcpTools: string[];
};
export type ResourceSelection = TaskScope & { skills: string[] };
export type AssemblyConfig = ResourceSelection & {
  agentId: string;
  displayName: string;
  version: string;
  capability: string;
  description: string;
  workflow: string;
  criteria: string[];
};
export function emptyConfig(): AssemblyConfig {
  return {
    agentId: "",
    displayName: "",
    version: "1.0.0",
    capability: "",
    description: "",
    workflow: "",
    criteria: [],
    skills: [],
    mcpTools: [],
    datasetIds: [],
    capabilities: [],
  };
}
export type AssemblyOption = {
  id: string;
  label: string;
  description?: string;
  version?: string;
  effect?: string;
  destination?: string;
  available?: boolean;
  inputSchema?: unknown;
  outputSchema?: unknown;
};
export type AssemblyOptions = {
  skills: AssemblyOption[];
  mcpTools: AssemblyOption[];
  capabilities: AssemblyOption[];
  datasets: { id: string; name: string }[];
  connection: { status: string; message?: string; observedAt?: string };
};
export type DraftSummary = {
  id: string;
  revision: number;
  description: string;
  config: AssemblyConfig;
  updatedAt?: string;
};
export type Candidate = {
  id: string;
  revision: number;
  agentId: string;
  version: string;
  packageDigest: string;
  config: AssemblyConfig;
  createdAt: string;
  releaseStatus?: string | null;
  publishedRunId?: string | null;
  buildEnvironment?: string;
};
export type AssemblyRun = {
  id: string;
  candidateId: string;
  packageDigest?: string;
  taskId: string;
  state: string;
  feedback?: string;
  accepted: boolean;
  candidateCompleted?: boolean;
  reviewId?: string | null;
  reviewRound?: number | null;
  reviewDecision?: string | null;
  reviewDecidedAt?: string | null;
  businessReview?: { status: string; criteriaIds: string[] };
  receipts?: (Partial<AssemblyReceipt> | null)[];
  assertions: {
    name: string;
    required: boolean;
    passed: boolean;
    message?: string;
  }[];
  criteria?: { id: string; priority: string; requirement: string }[];
  findings?: {
    id: string;
    status: string;
    reason?: string;
    evidenceIds?: string[];
  }[];
  createdAt: string;
};
export type AssemblyOperation = {
  id: string;
  kind: string;
  state: string;
  message?: string;
  createdAt: string;
  updatedAt?: string;
};
export type AssemblyDraft = DraftSummary & {
  baseRelease?: { agentId: string; version: string } | null;
  deletedAt?: string | null;
  messages: {
    role: string;
    content: string;
    requestId?: string;
    operationId?: string;
    candidateId?: string;
  }[];
  operations: AssemblyOperation[];
  candidates: Candidate[];
  runs: AssemblyRun[];
  suggestions?: Partial<ResourceSelection>;
};
export type UpgradeEntry =
  | { kind: "assembly"; draftId: string }
  | { kind: "package"; agentId: string; version: string };

export async function prepareAgentUpgrade(agent: Agent): Promise<UpgradeEntry> {
  if (!agent.assembly)
    return { kind: "package", agentId: agent.agentId, version: agent.version };
  const draft = await factoryApi.post<DraftSummary>(assemblies, {
    baseRelease: { agentId: agent.agentId, version: agent.version },
  });
  if (!draft?.id)
    throw Error("尚未确认已建立新版本，请重新读取智能体与版本列表。");
  return { kind: "assembly", draftId: draft.id };
}

export function editingVersionLabel(config: AssemblyConfig, state = "编辑中") {
  const name =
    config.displayName.trim() || config.agentId.trim() || "未命名智能体";
  const version = config.version.trim()
    ? "v" + config.version.trim()
    : "版本号待填写";
  return [name, version, state].filter(Boolean).join(" · ");
}

export function editableVersionOptions(
  drafts: DraftSummary[],
  state = "编辑中",
) {
  const labels = drafts.map((d) => editingVersionLabel(d.config, state));
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return drafts.map((draft, i) => ({
    id: draft.id,
    label:
      counts.get(labels[i])! > 1 ? labels[i] + " · " + draft.id : labels[i],
  }));
}

export function generationOptions(candidates: Candidate[]) {
  const recent = [...candidates].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  const builds = recent.map((candidate) => ({
    candidate,
    label: when(candidate.createdAt) + " · v" + candidate.version,
  }));
  const counts = new Map<string, number>();
  for (const { label } of builds)
    counts.set(label, (counts.get(label) ?? 0) + 1);
  return builds.map(({ candidate, label }) => ({
    candidate,
    label: counts.get(label)! > 1 ? label + " · " + candidate.id : label,
  }));
}
export type CandidateSource = {
  files: { path: string; content: string; previousContent?: string | null }[];
};
export type ResourceKind = "skill" | "mcp";
export type ResourceState = "active" | "unlisted" | "disabled";
export type ResourceVersion = AssemblyOption & {
  kind: ResourceKind;
  version: string;
  state: ResourceState;
  content?: string;
  files?: SkillFile[];
  fileCount?: number;
  toolId?: string;
  simulationToolId?: string;
  digest?: string;
  usedBy?: { agentId: string; version: string }[];
  runtimes?: string[];
};
export type ResourceDirectory = {
  items: ResourceVersion[];
  providers: AssemblyOption[];
};
export const effectLabel = (effect?: string) => {
  if (effect === "external_write") return "真实对外写入";
  if (
    effect === "simulate" ||
    effect === "simulated_write" ||
    effect === "simulation" ||
    effect === "simulated"
  )
    return "模拟写入";
  if (effect === "compose") return "生成内容";
  if (effect === "read") return "只读";
  return effect ?? "";
};
export const pendingOperation = (op: AssemblyOperation) =>
  ["queued", "pending", "running", "generating", "stopping"].includes(op.state);
export type TrialBlock = {
  message: string;
  action?: "review" | "edit" | "sample" | "plan" | "manage" | "currentBuild";
};

// Earlier control planes only reported the automatic assessment. Their acceptance
// endpoint requires all required findings to be met, even on a manually accepted task.
function legacyBusinessReview(run: AssemblyRun) {
  const required = (run.criteria ?? []).filter(
    (c) => c.priority === "required",
  );
  const unresolved = required.filter(
    (c) => !run.findings?.some((f) => f.id === c.id && f.status === "met"),
  );
  return {
    status: !required.length
      ? "no_criteria"
      : unresolved.length
        ? "legacy_unverified"
        : "met",
    criteriaIds: unresolved.map((c) => c.id),
  };
}

export function trialBlock(
  run: AssemblyRun,
  candidate?: Candidate,
): TrialBlock | null {
  if (
    candidate &&
    (candidate.id !== run.candidateId ||
      (run.packageDigest !== undefined &&
        run.packageDigest !== candidate.packageDigest))
  )
    return {
      message:
        "这份测试结果与所选生成记录的程序包不匹配。请选择匹配的记录或重新测试。",
      action: "sample",
    };
  const required = run.assertions.filter((a) => a.required);
  const failed = required.filter((a) => !a.passed);
  if (failed.length)
    return {
      message: `有 ${failed.length} 项必需固定测试未通过（${failed.map((a) => a.name).join("、")}）。请按断言结果修正智能体，重新生成并测试。`,
      action: "edit",
    };
  if (!["awaiting_review", "accepted"].includes(run.state)) {
    if (run.state === "awaiting_user_input")
      return {
        message: "测试正在等待答复。请打开工单补充输入，样例完成后再认可。",
        action: "plan",
      };
    if (
      ["failed", "planning_failed", "cancelled", "interrupted"].includes(
        run.state,
      )
    )
      return {
        message:
          "本次测试" +
          stateName(run.state) +
          "。请查看工单执行记录，修正原因后重新测试。",
        action: "sample",
      };
    return {
      message:
        "测试工单当前" +
        stateName(run.state) +
        "。请等样例执行和验收结束后刷新测试记录。",
      action: "plan",
    };
  }
  if (!required.length)
    return {
      message:
        "这次测试没有必需固定用例的结果。请补充固定用例，重新生成并测试。",
      action: "edit",
    };
  if (run.candidateCompleted === false)
    return {
      message: "本次工单缺少所选生成记录执行成功的证据。请用这个版本重新测试。",
      action: "sample",
    };
  const { status, criteriaIds } =
    run.businessReview ?? legacyBusinessReview(run);
  const names = criteriaIds
    .map((id) => run.criteria?.find((c) => c.id === id)?.requirement || id)
    .join("、");
  const items = names ? "（" + names + "）" : "";
  switch (status) {
    case "met":
    case "human_confirmed":
      return null;
    case "candidate_incomplete":
      return {
        message:
          "本次工单缺少所选生成记录执行成功的证据。请用这个版本重新测试。",
        action: "sample",
      };
    case "no_criteria":
      return {
        message:
          "工单缺少必需的样例验收条件。请在组装页核对工作说明与验收条件，再重新测试。",
        action: "edit",
      };
    case "missing":
      return {
        message:
          "样例缺少必需的交付内容" +
          items +
          "。请按逐项意见修正智能体或样例，再重新测试。",
        action: "edit",
      };
    case "needs_review":
      return run.state === "awaiting_review"
        ? {
            message:
              "必需项待人工核实" +
              items +
              "。请查看测试产物，在工单确认验收后回到这里认可结果。",
            action: "review",
          }
        : {
            message:
              "这份交付缺少本轮工单的人工验收决定。请刷新记录。若仍未记录，请重新测试并核对交付。",
            action: "sample",
          };
    case "no_evidence":
      return {
        message:
          "这次测试缺少可核对的交付或证据" +
          items +
          "。请查看测试产物，补充样例后重新测试。",
        action: "sample",
      };
    case "legacy_unverified":
      return {
        message:
          "中台尚未确认必需项" +
          items +
          "。请查看工单验收记录，刷新后核对。仍有缺项时请修正并重新测试。",
        action: "review",
      };
    default:
      return {
        message:
          "这次测试缺少逐项核验结果" +
          items +
          "。请刷新记录，仍有缺项时请重新测试。",
        action: "sample",
      };
  }
}
export const canAccept = (run: AssemblyRun) =>
  !run.accepted && !trialBlock(run);
export function useRequestId() {
  const last = useRef<{ signature: string; id: string } | null>(null);
  return {
    forPayload(payload: unknown) {
      const signature = JSON.stringify(payload);
      if (last.current?.signature !== signature)
        last.current = { signature, id: crypto.randomUUID() };
      return last.current.id;
    },
    confirmed() {
      last.current = null;
    },
  };
}
