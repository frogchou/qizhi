import { useRef } from "react";
import type { SkillFile } from "./skill-files";
import { when, type Agent, type AssemblyReceipt } from "./factory-model";
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
  taskId: string;
  state: string;
  feedback?: string;
  accepted: boolean;
  candidateCompleted?: boolean;
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
  messages: { role: string; content: string }[];
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
export const requiredChecksPassed = (run: AssemblyRun) =>
  run.assertions.some((a) => a.required) &&
  run.assertions.every((a) => !a.required || a.passed);
export const canAccept = (run: AssemblyRun) =>
  !run.accepted &&
  ["awaiting_review", "accepted"].includes(run.state) &&
  requiredChecksPassed(run) &&
  run.candidateCompleted !== false &&
  Boolean(
    run.criteria?.some((c) => c.priority === "required") &&
    run.criteria.every(
      (c) =>
        c.priority !== "required" ||
        run.findings?.some((f) => f.id === c.id && f.status === "met"),
    ),
  );
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
