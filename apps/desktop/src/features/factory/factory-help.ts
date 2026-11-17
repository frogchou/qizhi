export type FactoryHelpId =
  | "runtime"
  | "runtime-native"
  | "runtime-codex"
  | "runtime-unknown"
  | "task"
  | "agent"
  | "agent-version"
  | "orchestration"
  | "execution-instance"
  | "heartbeat"
  | "frozen-materials"
  | "artifact"
  | "factory-flows"
  | "human-review"
  | "stop-task"
  | "revision";

export type FactoryHelp = {
  title: string;
  description: string;
  detail?: string;
};

type FactoryHelpGroup = {
  title: string;
  description: string;
  ids: FactoryHelpId[];
};

const helpCatalogue: Record<FactoryHelpId, FactoryHelp> = {
  runtime: {
    title: "运行时",
    description: "智能体完成一次任务时实际使用的执行环境。",
  },
  "runtime-native": {
    title: "本地服务运行时",
    description:
      "由服务器上的智能体程序直接调用企业接口、知识库、文件或固定工具；不启动大模型推理。",
  },
  "runtime-codex": {
    title: "Codex 推理运行时",
    description:
      "智能体在本地服务中调用 Codex，适用于理解、生成、研究和质量判断。",
  },
  "runtime-unknown": {
    title: "未识别运行时",
    description:
      "中台保留了该运行时的原始标识；请在智能体版本说明中确认其实际执行方式。",
  },
  task: {
    title: "工单",
    description: "一次需求从接收、规划、执行到验收的完整记录。",
  },
  agent: {
    title: "智能体",
    description: "可独立部署、审核和调度的能力服务。",
  },
  "agent-version": {
    title: "智能体版本",
    description: "同一智能体的一次可追溯发布；中台只调度已上线版本。",
  },
  orchestration: {
    title: "任务编排",
    description: "中台根据需求和已上线能力安排节点、依赖和资料传递的执行图。",
  },
  "execution-instance": {
    title: "执行实例",
    description: "某个智能体为一个工单节点启动的一次独立运行。",
  },
  heartbeat: {
    title: "心跳",
    description: "执行实例定期上报的存活信号；它不是业务结果。",
  },
  "frozen-materials": {
    title: "冻结资料",
    description:
      "提交后复制到当前工单的资料快照；后续原文件变化不会改变本次任务。",
  },
  artifact: {
    title: "制品",
    description: "智能体生成并归档的文件，例如 PPT、报告或代码包。",
  },
  "factory-flows": {
    title: "园区流向",
    description:
      "任务流、资料流、算力供给和监控回报分别表示调度、资料绑定、运行时支撑和状态事件回传。",
  },
  "human-review": {
    title: "人工验收",
    description:
      "需要人工确认的成果会在交付前停在这里；你可以验收、退回重制或补充需求。",
  },
  "stop-task": {
    title: "停止工单",
    description:
      "停止未完成节点和等待输入，已产生的结果与历史仍可查看；停止后不能从停止点继续。",
  },
  revision: {
    title: "新一轮计划",
    description:
      "退回重制或补充需求会保留上一轮记录，并为当前工单建立新的执行计划；不会直接修改既有成果。",
  },
};

export const factoryHelpGroups: FactoryHelpGroup[] = [
  {
    title: "运行时",
    description: "智能体完成任务时使用的执行环境。",
    ids: ["runtime-native", "runtime-codex", "runtime-unknown"],
  },
  {
    title: "执行流程",
    description: "从需求接收、编排到实例执行的关键概念。",
    ids: [
      "task",
      "agent",
      "agent-version",
      "orchestration",
      "execution-instance",
      "heartbeat",
    ],
  },
  {
    title: "资料与交付",
    description: "本次工单使用的资料快照，以及最终可下载的成果。",
    ids: ["frozen-materials", "artifact", "factory-flows"],
  },
  {
    title: "审核与操作",
    description: "人工验收、停止和重新编排会带来的结果。",
    ids: ["human-review", "stop-task", "revision"],
  },
];

export function helpFor(id: FactoryHelpId): FactoryHelp {
  return helpCatalogue[id];
}

export function runtimeName(runtime: string | null | undefined): string {
  switch (runtime?.trim().toLowerCase()) {
    case "native":
      return "本地服务运行时";
    case "codex":
    case "codex_exec":
      return "Codex 推理运行时";
    case "":
    case undefined:
    case null:
      return "未记录";
    default:
      return runtime ?? "未记录";
  }
}

export function runtimeHelpId(
  runtime: string | null | undefined,
): FactoryHelpId {
  switch (runtime?.trim().toLowerCase()) {
    case "native":
      return "runtime-native";
    case "codex":
    case "codex_exec":
      return "runtime-codex";
    default:
      return "runtime-unknown";
  }
}
