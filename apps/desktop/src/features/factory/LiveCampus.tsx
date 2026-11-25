import { useEffect, useState, type CSSProperties } from "react";
import { areas, type Area } from "./simulation";
import { CampusSurface, type BuildingView } from "./CampusMap";
import { routes, reports, feeds, lots, sceneViewBox } from "./park-layout";
import {
  activeNode,
  activityArea,
  nodeArea,
  statusTone,
  stateName,
  when,
  type Activity,
  type Overview,
  type TaskDetail,
} from "./factory-model";

const metricLabels: Record<string, string> = {
  tasks: "工单",
  received: "待接单",
  channels: "来源",
  planning: "规划中",
  running: "执行中",
  planned: "已编排",
  plans: "计划",
  runningInstances: "运行实例",
  pendingReviewVersions: "待审核版本",
  readyVersions: "已上线版本",
  pendingReview: "待人工验收",
  automaticPassed: "自动通过",
  failed: "质检失败",
  configuredDatasets: "配置的知识库",
  inputs: "任务资料",
  artifacts: "归档制品",
  active: "运行实例",
  readyRuntimes: "可用运行时",
  staleInstances: "心跳超时",
  heartbeats: "心跳记录",
  events: "事件",
  accepted: "已验收工单",
  withArtifacts: "含文件的交付",
  attempts: "执行记录",
  connectedDatasets: "可读取知识库",
  qizhiDesktop: "栖知提交",
  api: "API 提交",
  console: "控制台提交",
  unknown: "未记录来源",
};
const fields: Record<Area, string[]> = {
  intake: ["tasks", "qizhiDesktop", "api", "console", "unknown"],
  control: ["planning", "running", "accepted", "plans"],
  line: ["runningInstances", "readyVersions", "pendingReviewVersions"],
  quality: ["pendingReview", "automaticPassed", "failed"],
  assets: ["configuredDatasets", "connectedDatasets", "inputs", "artifacts"],
  runtime: ["active", "readyRuntimes", "attempts"],
  monitor: ["staleInstances", "heartbeats", "events"],
  delivery: ["accepted", "withArtifacts", "artifacts"],
};
export const flowLegend = [
  ["任务流", "#00857b"],
  ["资料流", "#225cb0"],
  ["算力供给", "#c28c19"],
  ["监控回报", "#7252a6"],
] as const;

function freshEvents(events: Activity[], now: number) {
  return events.filter((e) => {
    const age = now - Date.parse(e.occurredAt);
    return age >= -2000 && age < 9000;
  });
}
function useMapNotes(events: Activity[]) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    setNow(current);
    const expirations = freshEvents(events, current).map(
      (e) => Date.parse(e.occurredAt) + 9000,
    );
    const timers = [...new Set(expirations)].map((end) =>
      window.setTimeout(
        () => setNow(Date.now()),
        Math.max(0, end - current) + 30,
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [events]);
  return freshEvents(events, now);
}
function currentPlanNodes(detail: TaskDetail) {
  const plan =
    detail.plans.find((p) => p.version === detail.task.current_plan_version) ??
    detail.plans[0];
  return detail.nodes.filter((n) => !plan || n.plan_id === plan.id);
}
function planAreas(detail: TaskDetail | null) {
  const selected = new Set<Area>();
  if (!detail) return selected;
  const { task } = detail;
  if (task.state === "received") selected.add("intake");
  if (["planning", "planned", "planning_failed"].includes(task.state))
    selected.add("control");
  if (task.state === "awaiting_review") selected.add("quality");
  if (task.state === "accepted") selected.add("delivery");
  for (const node of currentPlanNodes(detail)) {
    if (
      activeNode(node) ||
      (task.state === "awaiting_user_input" &&
        node.state === "awaiting_user_input") ||
      (task.state === "failed" && node.state === "failed")
    )
      selected.add(nodeArea(node.capability));
  }
  return selected;
}
export function LiveCampus({
  overview,
  events,
  area,
  onArea,
  detail,
  stale,
}: {
  overview: Overview | null;
  events: Activity[];
  area: Area | null;
  onArea: (area: Area) => void;
  detail: TaskDetail | null;
  stale: boolean;
}) {
  const notes = useMapNotes(events);
  const summary = overview?.areas;
  const metric = (a: Area, key: string) => summary?.[a]?.metrics[key] ?? 0;
  const active = (a: Area, k: string) => !stale && metric(a, k) > 0;
  const selected = planAreas(detail);
  const runningNodes =
    detail &&
    ["running", "planned", "stopping", "awaiting_user_input"].includes(
      detail.task.state,
    )
      ? currentPlanNodes(detail).filter(activeNode)
      : [];
  const current: Record<Area, boolean> = {
    intake: active("intake", "received"),
    control: active("control", "planning"),
    line: active("line", "runningNodes"),
    quality: active("quality", "checking"),
    assets: active("line", "retrievingNodes"),
    runtime: active("runtime", "active"),
    monitor: !stale && notes.some((e) => activityArea(e) === "monitor"),
    delivery: !stale && notes.some((e) => activityArea(e) === "delivery"),
  };
  const buildings = {} as Record<Area, BuildingView>;
  for (const section of areas) {
    const a = section.id,
      data = summary?.[a],
      metrics = data?.metrics;
    const state =
      stale || !data
        ? "idle"
        : a === "monitor" && active("monitor", "staleInstances")
          ? "blocked"
          : a === "quality" && active("quality", "pendingReview")
            ? "review"
            : current[a]
              ? "working"
              : "idle";
    buildings[a] = {
      status: state,
      statusLabel: data ? data.summary : "等待读取",
      count: data?.count ? data.count : undefined,
      ticket: selected.has(a) ? detail?.task.goal : undefined,
      tip: data ? (
        <>
          <div className="fc-tip-extra">{data.summary}</div>
          {data.connection && (
            <div>RAGFlow · {stateName(data.connection.status)}</div>
          )}
          {fields[a]
            .filter((k) => typeof metrics?.[k] === "number")
            .map((k) => (
              <div key={k} className="live-tip-metric">
                <span>{metricLabels[k]}</span>
                <b>{metrics![k]}</b>
              </div>
            ))}
          <small>
            {stale ? "上次快照" : "快照"} · {when(overview?.observedAt, true)}
          </small>
        </>
      ) : (
        <p>{stale ? "中台数据不可用" : "正在读取中台数据"}</p>
      ),
    };
  }
  const graphWork = detail
    ? !stale && selected.has("control") && detail.task.state === "planning"
    : current.control;
  const execution = detail ? !stale && runningNodes.length > 0 : current.line;
  const retrieving = detail
    ? !stale && runningNodes.some((n) => nodeArea(n.capability) === "assets")
    : current.assets;
  const checking = detail
    ? !stale && runningNodes.some((n) => nodeArea(n.capability) === "quality")
    : current.quality;
  const shown = detail
    ? notes.filter((e) => e.taskId === detail.task.id)
    : notes;
  const routesOn = [
    detail ? !stale && detail.task.state === "received" : current.intake,
    graphWork,
    retrieving,
    retrieving,
    checking,
    shown.some((e) => activityArea(e) === "delivery") && !stale,
  ];
  const streams = [
    ...routes.map((d, i) => ({
      d,
      kind: i === 2 || i === 3 ? 1 : 0,
      live: routesOn[i],
    })),
    ...reports.map((r) => ({
      d: r.d,
      kind: 3,
      live:
        !stale &&
        shown.some(
          (e) =>
            activityArea(e) === r.area ||
            (activityArea(e) === "monitor" &&
              e.detail?.capability &&
              nodeArea(e.detail.capability) === r.area),
        ),
    })),
    { d: feeds.line, kind: 2, live: execution && current.runtime },
    {
      d: feeds.control,
      kind: 2,
      live: graphWork && active("runtime", "planning"),
    },
  ];
  return (
    <CampusSurface
      buildings={buildings}
      area={area}
      onArea={onArea}
      speed={stale || !overview ? 0 : 1}
      traffic={
        stale ? 0 : metric("runtime", "active") + metric("control", "planning")
      }
      channels={[]}
      receiving={current.intake}
      load={{
        control: graphWork,
        runtime: current.runtime || graphWork,
        line: execution,
        quality: checking,
        monitor: current.monitor,
      }}
      activity={(hover) => (
        <>
          <svg
            className="eco-flows"
            viewBox={sceneViewBox}
            aria-hidden="true"
            preserveAspectRatio="none"
          >
            {streams.map(({ d, kind, live }, i) => (
              <g
                key={d}
                data-flow={live ? "live" : "idle"}
                data-kind={["task", "asset", "power", "monitor"][kind]}
                style={
                  {
                    "--flow": flowLegend[kind][1],
                    "--period": "2.3s",
                    "--offset": -i * 0.2 + "s",
                  } as CSSProperties
                }
              >
                <path className="eco-guide" d={d} />
                {live && (
                  <>
                    <path className="eco-core" d={d} />
                    <path className="eco-packets" d={d} />
                  </>
                )}
              </g>
            ))}
          </svg>
          <div className="eco-notes" aria-hidden="true">
            {!stale &&
              shown
                .filter((e, i, list) => {
                  const station = activityArea(e);
                  return (
                    station !== hover &&
                    list.findIndex((x) => activityArea(x) === station) === i
                  );
                })
                .slice(0, 2)
                .map((e) => {
                  const station = activityArea(e),
                    [, y, , h, x] = lots[station];
                  return (
                    <div
                      key={e.id}
                      className={
                        "eco-note live-event-note " + statusTone(e.state)
                      }
                      style={{
                        left: `clamp(82px,${x}%,calc(100% - 82px))`,
                        top: (y < 58 ? y + h + 1 : y - 4) + "%",
                      }}
                    >
                      <small>
                        {stateName(e.state)} · {when(e.occurredAt, true)}
                      </small>
                      <strong>{e.message}</strong>
                    </div>
                  );
                })}
          </div>
        </>
      )}
    />
  );
}
