import { ControlIcon } from "../../components/ControlIcon";
import { useEffect, useRef, useState } from "react";
import { areas, type Area } from "./simulation";
import { useFactoryFeed, useFactoryRead } from "./factory-feed";
import { LiveCampus, flowLegend } from "./LiveCampus";
import {
  AgentDetail,
  Assets,
  Deliveries,
  Intake,
  Monitor,
  QualityDesk,
  Runtimes,
  TaskList,
} from "./FactoryAreas";
import { FactoryTaskDetail } from "./FactoryTaskDetail";
import { RequirementForm, ReleaseForm } from "./FactoryForms";
import { AssemblyWorkspace } from "./AssemblyWorkspace";
import type { TaskScope } from "./assembly-model";
import {
  ContextHelp,
  FactoryGuide,
  Modal,
  ReadNotice,
} from "./FactoryControls";
import {
  when,
  type Agent,
  type OpenAgent,
  type OpenTask,
  type TaskDetail,
  type TaskLink,
} from "./factory-model";
import "./factory.css";
import "./live-factory.css";

type Location =
  | { kind: "building"; area: Area; filter?: string }
  | { kind: "queue" }
  | { kind: "task"; link: TaskLink }
  | { kind: "agent"; id: string; version: string };
type ModalState =
  | { kind: "new"; scope?: TaskScope }
  | { kind: "release"; agent: Agent | null }
  | { kind: "guide" };
const nameForArea = (id: Area) =>
  id === "line" ? "智能体生产线" : areas.find((a) => a.id === id)!.name;
function locationKey(view: Location) {
  if (view.kind === "building")
    return view.kind + "-" + view.area + "-" + (view.filter ?? "");
  if (view.kind === "task") return view.kind + "-" + view.link.id;
  if (view.kind === "agent")
    return view.kind + "-" + view.id + "-" + view.version;
  return view.kind;
}
export function LiveFactoryPage({
  endpoint,
  onKnowledge,
  onSettings,
}: {
  endpoint: string;
  onKnowledge: () => void;
  onSettings: () => void;
}) {
  const feed = useFactoryFeed();
  const [history, setHistory] = useState<Location[]>([]),
    [modal, setModal] = useState<ModalState | null>(null);
  const [lineVisited, setLineVisited] = useState(false);
  const readBlocked = feed.state !== "live";
  const view = history[history.length - 1],
    open = Boolean(view),
    selectedArea = view?.kind === "building" ? view.area : null;
  const task = view?.kind === "task" ? view.link : null;
  const tracked = useFactoryRead<TaskDetail>(
    task ? `/v1/tasks/${encodeURIComponent(task.id)}` : null,
    feed.revision,
  );
  const closeButton = useRef<HTMLButtonElement>(null),
    queueButton = useRef<HTMLButtonElement>(null),
    opener = useRef<HTMLElement | null>(null);
  const drawer = useRef<HTMLElement>(null);
  const viewKey = view ? locationKey(view) : "";
  useEffect(() => {
    if (open) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      closeButton.current?.focus({ preventScroll: true });
    } else if (opener.current) {
      const target = opener.current;
      opener.current = null;
      (target.isConnected && target !== document.body
        ? target
        : queueButton.current
      )?.focus({ preventScroll: true });
    }
  }, [open]);
  useEffect(() => {
    if (drawer.current) drawer.current.scrollTop = 0;
  }, [viewKey]);
  useEffect(() => {
    if (!open || modal) return;
    // A successful server action can remove the focused control before the next keypress.
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        setHistory([]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, modal]);
  const overview = () => setHistory([]);
  const openArea = (area: Area, filter?: string) => {
    if (area === "line") setLineVisited(true);
    setHistory([{ kind: "building", area, filter }]);
  };
  function push(next: Location) {
    setHistory((old) =>
      old.length && locationKey(old[old.length - 1]) === locationKey(next)
        ? [...old.slice(0, -1), next]
        : [...old, next].slice(-12),
    );
  }
  const onTask: OpenTask = (id, title, tab = "plan") =>
    push({ kind: "task", link: { id, title, tab } });
  const onAgent: OpenAgent = (id, version) =>
    push({ kind: "agent", id, version });
  const metrics = feed.overview?.areas;
  const quick: [string, string, number | undefined, () => void][] = [
    [
      "工作中",
      "working",
      metrics?.line.metrics.activeTasks,
      () =>
        setHistory([
          { kind: "building", area: "control", filter: "active_nodes" },
        ]),
    ],
    [
      "待人工验收",
      "review",
      metrics?.quality.metrics.pendingReview,
      () => openArea("quality", "pending_review"),
    ],
    [
      "质检失败",
      "blocked",
      metrics?.quality.metrics.failed,
      () => openArea("quality", "failed"),
    ],
    [
      "已验收",
      "done",
      metrics?.delivery.metrics.accepted,
      () => openArea("delivery"),
    ],
  ];
  const latest = feed.events.slice(0, 2);
  const areaProps = { revision: feed.revision, onTask };
  function contents() {
    if (!view) return null;
    if (view.kind === "queue") return <TaskList {...areaProps} />;
    if (view.kind === "task")
      return (
        <>
          <ReadNotice read={tracked} />
          {tracked.data && (
            <FactoryTaskDetail
              detail={tracked.data}
              tab={view.link.tab}
              onTab={(tab) =>
                setHistory((h) => [
                  ...h.slice(0, -1),
                  { kind: "task", link: { ...view.link, tab } },
                ])
              }
              onAgent={onAgent}
              onChange={feed.refresh}
              refreshTask={() => {
                tracked.retry();
                feed.refresh();
              }}
              stale={readBlocked || Boolean(tracked.error)}
            />
          )}
        </>
      );
    if (view.kind === "agent")
      return (
        <AgentDetail
          id={view.id}
          version={view.version}
          {...areaProps}
          onRelease={(agent) => setModal({ kind: "release", agent })}
          onChange={feed.refresh}
          stale={readBlocked}
        />
      );
    switch (view.area) {
      case "intake":
        return <Intake {...areaProps} />;
      case "control":
        return (
          <TaskList
            {...areaProps}
            initialState={view.filter ?? "in_progress"}
            title="工单与编排计划"
          />
        );
      case "line":
        return null;
      case "quality":
        return <QualityDesk {...areaProps} initialFilter={view.filter} />;
      case "assets":
        return <Assets revision={feed.revision} onKnowledge={onKnowledge} />;
      case "runtime":
        return <Runtimes {...areaProps} onAgent={onAgent} />;
      case "monitor":
        return <Monitor {...areaProps} />;
      case "delivery":
        return <Deliveries {...areaProps} />;
    }
  }
  const title =
    view?.kind === "building"
      ? nameForArea(view.area)
      : view?.kind === "task"
        ? tracked.data?.task.goal || view.link.title
        : view?.kind === "agent"
          ? "智能体版本详情"
          : "工单队列";
  return (
    <section className="fc fc-live" aria-label="智能工厂">
      <header className="fc-head">
        <h1>智能工厂</h1>
        <div className="fc-tabs">
          <button aria-pressed={!task} onClick={overview}>
            全厂总览
          </button>
          <button
            aria-pressed={!!task}
            disabled={!task}
            onClick={() => task && onTask(task.id, task.title, task.tab)}
          >
            跟随工单
          </button>
        </div>
        <button
          type="button"
          className="fc-demo live-mode"
          onClick={onSettings}
          title={endpoint || "设置中台连接"}
        >
          中台实况
        </button>
        <button
          type="button"
          className="ui-action ui-quiet ui-small"
          onClick={() => setModal({ kind: "guide" })}
        >
          工厂说明
        </button>
        <button
          className="ui-action ui-primary"
          disabled={readBlocked}
          onClick={() => setModal({ kind: "new" })}
        >
          <ControlIcon name="plus" size={16} /> 新建需求
        </button>
      </header>
      <div className="fc-stats">
        {quick.map(([label, klass, count, click]) => (
          <button key={label} className={klass} onClick={click}>
            <i />
            {label}
            <strong>{count ?? "—"}</strong>
          </button>
        ))}
        <button
          className="fc-queue-toggle"
          ref={queueButton}
          aria-controls="factory-live-inspector"
          aria-expanded={open}
          onClick={() => (open ? overview() : setHistory([{ kind: "queue" }]))}
        >
          {open ? "收起面板" : "工单队列"}
        </button>
      </div>
      {feed.error && (
        <div className="live-connection-error" role="status">
          <span>
            {feed.overview ? "当前显示上次快照" : "无法读取工厂数据"} ·{" "}
            {feed.error}
          </span>
          <button onClick={onSettings}>连接设置</button>
        </div>
      )}
      <div className="fc-body">
        <div
          className="fc-scene"
          onClick={(e) => {
            if (
              open &&
              e.target instanceof Element &&
              e.target.closest(".fc-map") &&
              !e.target.closest("button")
            )
              overview();
          }}
        >
          <LiveCampus
            area={selectedArea}
            onArea={openArea}
            overview={feed.overview}
            events={feed.events}
            detail={task ? tracked.data : null}
            stale={readBlocked}
          />
          <aside
            ref={drawer}
            id="factory-live-inspector"
            aria-label="工厂详情面板"
            className="fc-inspector live-inspector"
            data-assembly={selectedArea === "line"}
            data-open={open}
            inert={!open}
            aria-hidden={!open}
          >
            <div className="fc-drawer-head">
              <h2>{title}</h2>
              <button
                type="button"
                ref={closeButton}
                onClick={overview}
                className="ui-icon-button ui-close"
                aria-label="关闭抽屉"
                title="关闭抽屉"
              >
                <ControlIcon name="x" size={17} />
              </button>
            </div>
            {history.length > 1 && (
              <button
                type="button"
                className="fc-back live-back"
                onClick={() => setHistory((h) => h.slice(0, -1))}
              >
                ← 返回上一级
              </button>
            )}
            <div className="live-drawer-content" key={viewKey}>
              {contents()}
            </div>
            {lineVisited && (
              <AssemblyWorkspace
                active={selectedArea === "line"}
                endpoint={endpoint}
                revision={feed.revision}
                stale={readBlocked}
                onChange={feed.refresh}
                onTask={onTask}
                onNewTask={(scope) => setModal({ kind: "new", scope })}
              />
            )}
          </aside>
        </div>
        <div className="fc-tools">
          <div className="eco-legend" aria-label="线路图例">
            {flowLegend.map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
            <ContextHelp id="factory-flows" label="解释：园区流向" />
          </div>
          <span className={"live-sync " + feed.state} role="status">
            <i />
            {feed.state === "live"
              ? "实时连接"
              : feed.state === "loading"
                ? "正在连接中台"
                : "连接中断 · 正在重连"}
            {feed.overview && (
              <time>快照 {when(feed.overview.observedAt, true)}</time>
            )}
          </span>
          <button type="button" onClick={feed.refresh}>
            刷新
          </button>
        </div>
      </div>
      <footer className="fc-events">
        <strong>最近动态</strong>
        {latest.length ? (
          latest.map((e) => (
            <button
              key={e.id}
              title={e.message}
              onClick={() => onTask(e.taskId, e.taskId, "monitor")}
            >
              <time>{when(e.occurredAt, true)}</time>
              <span>{e.message}</span>
            </button>
          ))
        ) : (
          <span className="live-subtle">
            {feed.overview ? "暂无任务动态" : "正在读取中台记录"}
          </span>
        )}
      </footer>
      {modal?.kind === "new" && (
        <RequirementForm
          seed={modal.scope}
          stale={readBlocked}
          onClose={() => setModal(null)}
          onCreated={onTask}
          refresh={feed.refresh}
        />
      )}
      {modal?.kind === "release" && (
        <ReleaseForm
          stale={readBlocked}
          agent={modal.agent}
          onClose={() => setModal(null)}
          onAgent={onAgent}
          refresh={feed.refresh}
        />
      )}
      {modal?.kind === "guide" && (
        <Modal title="智能工厂说明" onClose={() => setModal(null)}>
          <FactoryGuide />
        </Modal>
      )}
    </section>
  );
}
