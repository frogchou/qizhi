export const areas = [
  {
    id: "intake",
    name: "需求接待大厅",
    description: "接收需求并创建工单",
  },
  {
    id: "control",
    name: "智能体中台",
    description: "分析意图、选择能力并编排任务",
  },
  {
    id: "line",
    name: "生产线",
    description: "运行专业智能体并汇集各节点产物",
  },
  {
    id: "quality",
    name: "质检中心",
    description: "核验产物、处理人工审批与返工",
  },
  {
    id: "delivery",
    name: "成果交付中心",
    description: "归集通过验收的工单与制品",
  },
  {
    id: "assets",
    name: "企业资产仓",
    description: "知识库、记忆、数据库与业务资料",
  },
  {
    id: "runtime",
    name: "运行时支撑中心",
    description: "为中台规划和生产线执行提供运行环境",
  },
  {
    id: "monitor",
    name: "运行监控中心",
    description: "汇集实例心跳、异常与执行日志",
  },
] as const;

export type Area = (typeof areas)[number]["id"];
export type Status = "working" | "blocked" | "review" | "done";
export const statusName: Record<Status, string> = {
  working: "工作中",
  blocked: "已阻塞",
  review: "待审批",
  done: "已交付",
};
export const steps = [
  {
    name: "接收需求",
    area: "intake",
    duration: 3,
    message: "接待大厅已登记工单",
  },
  {
    name: "生成计划",
    area: "control",
    duration: 5,
    message: "中台正在编排检索、制作与质量检查节点",
  },
  {
    name: "检索知识",
    area: "assets",
    duration: 8,
    message: "知识检索工位从模拟资料库获取参考片段",
  },
  {
    name: "制作成果",
    area: "line",
    duration: 24,
    message: "制作智能体已接收参考资料，正在生成交付草稿",
  },
  {
    name: "质量检查",
    area: "quality",
    duration: 7,
    message: "质检中心正在核对完整性与引用来源",
  },
  {
    name: "成果交付",
    area: "delivery",
    duration: 0,
    message: "模拟交付物已归档，可查看交付单",
  },
] as const;
type Entry = { at: number; message: string; area: Area; status: Status };
export type Job = {
  id: number;
  title: string;
  step: number;
  status: Status;
  manual: boolean;
  entered: number;
  created: number;
  beat: number;
  round: number;
  events: Entry[];
  demoArrival?: boolean;
};
export type World = { time: number; nextId: number; jobs: Job[] };
export type Action =
  | { type: "tick"; seconds: number }
  | { type: "create"; title: string; manual: boolean; demoArrival?: boolean }
  | { type: "approve" | "retry" | "rework"; id: number };
function note(
  job: Job,
  at: number,
  message: string,
  area: Area = steps[job.step].area,
): Job {
  return {
    ...job,
    events: [...job.events, { at, message, area, status: job.status }].slice(
      -64,
    ),
  };
}
function move(job: Job, step: number, at: number): Job {
  return note(
    {
      ...job,
      step,
      entered: at,
      beat: at,
      status: step === 5 ? "done" : "working",
    },
    at,
    steps[step].message,
  );
}
function seed(id: number, title: string, step: number, status: Status): Job {
  const events = steps.slice(0, step + 1).map((s, i) => ({
    at: i * 5,
    message: s.message,
    area: s.area,
    status: "working" as Status,
  }));
  const job: Job = {
    id,
    title,
    step,
    status,
    manual: true,
    entered: 30,
    created: 0,
    beat: 30,
    round: 1,
    events,
  };
  if (status === "blocked")
    return note(
      { ...job, beat: 16 },
      29,
      "模拟资料连接超时，节点已暂停，可重试",
    );
  if (status === "review")
    return note(job, 30, "质检报告已生成，等待管理员确认");
  return note(job, 30, steps[step].message);
}
export function initialWorld(): World {
  return {
    time: 30,
    nextId: 105,
    jobs: [
      seed(104, "栖知产品介绍 PPT", 3, "working"),
      seed(103, "供应商资料汇总", 2, "blocked"),
      seed(102, "年度方案质量复核", 4, "review"),
      seed(101, "项目摘要整理", 5, "done"),
    ],
  };
}
export function usesArea(job: Job, area: Area): boolean {
  if (area === "monitor") return job.status !== "done";
  if (area === "runtime")
    return job.status === "working" && [1, 3, 4].includes(job.step);
  if (area === "line" && job.step === 2) return true;
  return steps[job.step].area === area;
}
export function reduceWorld(world: World, action: Action): World {
  if (action.type === "create") {
    const title = action.title.trim().slice(0, 120);
    if (!title) return world;
    const job = move(
      {
        id: world.nextId,
        title,
        manual: action.manual,
        demoArrival: action.demoArrival,
        round: 1,
        created: world.time,
        events: [],
        step: 0,
        status: "working",
        entered: world.time,
        beat: world.time,
      },
      0,
      world.time,
    );
    // Bound the automatic demonstration history while retaining operator-created jobs.
    let archived = 0;
    const retained = world.jobs.filter(
      (j) => !j.demoArrival || j.status !== "done" || ++archived <= 24,
    );
    return { ...world, nextId: world.nextId + 1, jobs: [job, ...retained] };
  }
  if (action.type === "tick") {
    const time = world.time + action.seconds;
    const jobs = world.jobs.map((job) => {
      if (job.status !== "working") return job;
      if (time - job.entered >= steps[job.step].duration) {
        if (job.step === 4 && job.manual)
          return note(
            { ...job, status: "review", beat: time },
            time,
            "质检完成，等待管理员确认",
          );
        return move(job, job.step + 1, time);
      }
      if (time - job.beat < 3) return job;
      const pulse = { ...job, beat: time };
      return (time - job.entered) % 12 === 0
        ? note(pulse, time, "收到节点心跳 · " + steps[job.step].name, "monitor")
        : pulse;
    });
    return { ...world, time, jobs };
  }
  return {
    ...world,
    jobs: world.jobs.map((job) => {
      if (job.id !== action.id) return job;
      if (action.type === "approve" && job.status === "review")
        return move(note(job, world.time, "管理员已验收"), 5, world.time);
      if (action.type === "retry" && job.status === "blocked")
        return move(
          note(
            { ...job, round: job.round + 1 },
            world.time,
            "资料连接已恢复，重新尝试",
          ),
          job.step,
          world.time,
        );
      if (action.type === "rework" && job.status === "review")
        return move(
          note(
            { ...job, round: job.round + 1 },
            world.time,
            "管理员退回制作工位，保留上版记录",
          ),
          3,
          world.time,
        );
      return job;
    }),
  };
}
export function clock(time: number) {
  return [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
