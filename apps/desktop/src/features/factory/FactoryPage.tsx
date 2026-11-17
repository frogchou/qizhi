import { ControlIcon } from "../../components/ControlIcon";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { CampusMap } from "./CampusMap";
import {
  areas,
  steps,
  statusName,
  initialWorld,
  reduceWorld,
  clock,
  usesArea,
  type Area,
  type Job,
  type Status,
  type World,
  type Action,
} from "./simulation";
import "./factory.css";

type Filter = "all" | Status;
const filters: Status[] = ["working", "blocked", "review", "done"];
function Badge({ status }: { status: Status }) {
  return (
    <span className={"fc-badge " + status}>
      <i />
      {statusName[status]}
    </span>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      className="fc-modal"
      ref={dialog}
      aria-label={title}
      onCancel={close}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="ui-icon-button ui-close"
          onClick={close}
          aria-label="关闭窗口"
          title="关闭窗口"
        >
          <ControlIcon name="x" size={17} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
function JobList({
  jobs,
  follow,
}: {
  jobs: Job[];
  follow: (id: number) => void;
}) {
  return (
    <div className="fc-list">
      {jobs.length ? (
        jobs.map((job) => (
          <button key={job.id} onClick={() => follow(job.id)}>
            <small>
              工单 {job.id} · {steps[job.step].name}
            </small>
            <strong>{job.title}</strong>
            <Badge status={job.status} />
          </button>
        ))
      ) : (
        <p className="fc-empty">此处暂无工单</p>
      )}
    </div>
  );
}
function FactoryView({
  world,
  dispatch,
  speed,
  setSpeed,
  autoDemo,
  setAutoDemo,
  onOpenKnowledge,
}: {
  autoDemo: boolean;
  setAutoDemo: (enabled: boolean) => void;
  world: World;
  dispatch: (a: Action) => void;
  speed: number;
  setSpeed: (n: number) => void;
  onOpenKnowledge: () => void;
}) {
  const [id, setId] = useState<number | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [area, setArea] = useState<Area | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [modal, setModal] = useState<"new" | "log" | "result" | null>(null);
  const [title, setTitle] = useState("");
  const [manual, setManual] = useState(true);
  const job = world.jobs.find((j) => j.id === id);
  const station = areas.find((a) => a.id === area);
  const drawerOpen = Boolean(queueOpen || area || job || filter !== "all");
  const drawerClose = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const queueButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (drawerOpen) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      drawerClose.current?.focus({ preventScroll: true });
    } else if (opener.current) {
      const target = opener.current;
      opener.current = null;
      (target.isConnected && target !== document.body
        ? target
        : queueButton.current
      )?.focus({ preventScroll: true });
    }
  }, [drawerOpen]);
  function overview() {
    setQueueOpen(false);
    setId(null);
    setArea(null);
    setFilter("all");
    setModal(null);
  }
  function follow(next: number) {
    setId(next);
    setArea(null);
    setModal(null);
  }
  const visibleJobs = world.jobs.filter(
    (j) =>
      (filter === "all" || j.status === filter) && (!area || usesArea(j, area)),
  );
  const entries = world.jobs
    .flatMap((j) =>
      j.events.map((e, i) => ({
        ...e,
        id: j.id,
        key: j.id + "-" + i,
        title: j.title,
      })),
    )
    .sort((a, b) => b.at - a.at);
  return (
    <section
      className="fc"
      aria-label="智能工厂"
      onKeyDown={(event) => {
        if (event.key === "Escape" && drawerOpen && !modal) {
          event.preventDefault();
          overview();
        }
      }}
    >
      <header className="fc-head">
        <h1>智能工厂</h1>
        <div className="fc-tabs">
          <button aria-pressed={!job} onClick={overview}>
            全厂总览
          </button>
          <button
            aria-pressed={!!job}
            disabled={!job}
            onClick={() => job && follow(job.id)}
          >
            跟随工单
          </button>
        </div>
        <span className="fc-demo">模拟数据</span>
        <button
          className="ui-action ui-primary"
          onClick={() => {
            setTitle("");
            setManual(true);
            setModal("new");
          }}
        >
          <ControlIcon name="plus" size={16} /> 新建需求
        </button>
      </header>
      <div className="fc-stats">
        {filters.map((s) => (
          <button
            key={s}
            className={s}
            aria-pressed={!job && filter === s}
            onClick={() => {
              setId(null);
              setArea(null);
              setFilter(filter === s ? "all" : s);
            }}
          >
            <i />
            {statusName[s]}
            <strong>{world.jobs.filter((j) => j.status === s).length}</strong>
          </button>
        ))}
        <button
          className="fc-queue-toggle"
          ref={queueButton}
          aria-controls="factory-inspector"
          aria-expanded={drawerOpen}
          onClick={() => {
            if (drawerOpen) overview();
            else setQueueOpen(true);
          }}
        >
          工单队列
        </button>
      </div>
      <div className="fc-body">
        <div
          className="fc-scene"
          onClick={(event) => {
            if (
              drawerOpen &&
              event.target instanceof Element &&
              event.target.closest(".fc-map") &&
              !event.target.closest("button")
            )
              overview();
          }}
        >
          <CampusMap
            world={world}
            job={job}
            area={area}
            speed={speed}
            onArea={(a) => {
              setArea(a);
              setFilter("all");
              setId(null);
            }}
          />
          <aside
            id="factory-inspector"
            className="fc-inspector"
            aria-label="工单面板"
            data-open={drawerOpen}
            inert={!drawerOpen}
            aria-hidden={!drawerOpen}
          >
            <div className="fc-drawer-head">
              <h2>
                {job?.title ??
                  station?.name ??
                  (filter === "all" ? "工单队列" : statusName[filter] + "工单")}
              </h2>
              <button
                type="button"
                ref={drawerClose}
                onClick={overview}
                className="ui-icon-button ui-close"
                aria-label="关闭抽屉"
                title="关闭抽屉"
              >
                <ControlIcon name="x" size={17} />
              </button>
            </div>
            {job ? (
              <>
                <small>
                  工单 {job.id} · 第 {job.round} 次尝试
                </small>
                <Badge status={job.status} />
                <ol className="fc-steps">
                  {steps.map((s, i) => (
                    <li
                      key={s.area}
                      className={
                        i < job.step || job.status === "done"
                          ? "past"
                          : i === job.step
                            ? "current"
                            : ""
                      }
                    >
                      <i />
                      {s.name}
                      <small>
                        {i < job.step || job.status === "done"
                          ? "已完成"
                          : i === job.step
                            ? statusName[job.status]
                            : "等待"}
                      </small>
                    </li>
                  ))}
                </ol>
                <dl>
                  <dt>工单耗时</dt>
                  <dd>
                    {clock(
                      (job.status === "done" ? job.entered : world.time) -
                        job.created,
                    )}
                  </dd>
                  <dt>最近回报</dt>
                  <dd>{clock(job.beat)}</dd>
                </dl>
                <p className="fc-reason">
                  {job.events[job.events.length - 1]?.message}
                </p>
                <div className="fc-actions">
                  {job.status === "blocked" && (
                    <button
                      className="ui-action ui-primary"
                      onClick={() => dispatch({ type: "retry", id: job.id })}
                    >
                      重试此节点
                    </button>
                  )}
                  {job.status === "review" && (
                    <>
                      <button
                        className="ui-action ui-primary"
                        onClick={() =>
                          dispatch({ type: "approve", id: job.id })
                        }
                      >
                        批准交付
                      </button>
                      <button
                        onClick={() => dispatch({ type: "rework", id: job.id })}
                      >
                        退回制作
                      </button>
                    </>
                  )}
                  {job.status === "done" && (
                    <button
                      className="ui-action ui-primary"
                      onClick={() => setModal("result")}
                    >
                      查看交付单
                    </button>
                  )}
                  <button onClick={() => setModal("log")}>查看执行日志</button>
                </div>
              </>
            ) : (
              <>
                {station && <p className="fc-reason">{station.description}</p>}
                {station?.id === "assets" && (
                  <>
                    <div className="fc-tags">
                      知识库 · 数据库 · 记忆 · 三方系统
                    </div>
                    <button
                      type="button"
                      className="ui-action ui-primary fc-open-knowledge"
                      onClick={onOpenKnowledge}
                    >
                      打开栖知知识库
                    </button>
                  </>
                )}
                {station?.id === "runtime" && (
                  <div className="fc-tags">
                    模拟运行环境 · Codex 推理 / 本地服务
                  </div>
                )}
                <JobList jobs={visibleJobs} follow={follow} />
              </>
            )}
          </aside>
        </div>
        <div className="fc-tools">
          <div className="eco-legend" aria-label="线路图例">
            {[
              ["任务流", "#00857b"],
              ["资料流", "#225cb0"],
              ["算力供给", "#c28c19"],
              ["监控回报", "#7252a6"],
            ].map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
          <label className="eco-demo">
            <input
              type="checkbox"
              checked={autoDemo}
              onChange={(e) => setAutoDemo(e.target.checked)}
            />
            模拟来单
          </label>
          <span>
            演示时钟 <b>{clock(world.time)}</b>
          </span>
          <div>
            <button
              aria-label={speed ? "暂停模拟" : "继续模拟"}
              onClick={() => setSpeed(speed ? 0 : 1)}
            >
              {speed ? "暂停" : "继续"}
            </button>
            <button
              aria-label="切换模拟速度"
              onClick={() => setSpeed(speed === 4 ? 1 : 4)}
            >
              {speed || 1}×
            </button>
          </div>
        </div>
      </div>
      <footer className="fc-events">
        <strong>最近动态</strong>
        {entries.slice(0, 2).map((e) => (
          <button key={e.key} onClick={() => follow(e.id)}>
            <time>{clock(e.at)}</time>
            <span>
              {e.title} · {e.message}
            </span>
          </button>
        ))}
      </footer>
      {modal === "new" && (
        <Modal title="新建需求" close={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim()) return;
              dispatch({ type: "create", title, manual });
              follow(world.nextId);
            }}
          >
            <label>
              需求内容
              <textarea
                autoFocus
                required
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如，基于栖知资料制作产品介绍 PPT"
              />
            </label>
            <label className="fc-check">
              <input
                type="checkbox"
                checked={manual}
                onChange={(e) => setManual(e.target.checked)}
              />
              质检完成后由我审批
            </label>
            <footer>
              <button
                type="button"
                className="ui-action ui-quiet"
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button disabled={!title.trim()} className="ui-action ui-primary">
                提交并跟随
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {modal === "log" && job && (
        <Modal title="执行日志" close={() => setModal(null)}>
          <p>{job.title}</p>
          <ul className="fc-log">
            {job.events.map((e, i) => (
              <li key={i}>
                <time>{clock(e.at)}</time>
                {e.message}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {modal === "result" && job && (
        <Modal title="模拟交付单" close={() => setModal(null)}>
          <h3>{job.title}</h3>
          <p>
            工单 {job.id} 已归档 · {clock(job.entered)}
          </p>
          <p>已完成模拟检索、制作和质量检查。本次演示生成流程记录。</p>
          <button onClick={() => setModal("log")}>查看流程记录</button>
        </Modal>
      )}
    </section>
  );
}
export function FactoryPage({
  active,
  onOpenKnowledge,
}: {
  active: boolean;
  onOpenKnowledge: () => void;
}) {
  const [world, dispatch] = useReducer(reduceWorld, undefined, initialWorld);
  const [speed, setSpeed] = useState(1);
  const [autoDemo, setAutoDemo] = useState(true);
  const demoTick = useRef(0);
  useEffect(() => {
    if (!active || !speed) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      dispatch({ type: "tick", seconds: 1 });
      if (autoDemo && ++demoTick.current % 19 === 4) {
        const titles = [
          "检索项目里程碑",
          "核对交付资料",
          "更新产品提纲",
          "整理会议纪要",
        ];
        dispatch({
          type: "create",
          title: titles[Math.floor(demoTick.current / 19) % titles.length],
          manual: false,
          demoArrival: true,
        });
      }
    }, 1000 / speed);
    return () => window.clearInterval(timer);
  }, [active, speed, autoDemo]);
  return active ? (
    <FactoryView
      world={world}
      dispatch={dispatch}
      speed={speed}
      setSpeed={setSpeed}
      autoDemo={autoDemo}
      setAutoDemo={setAutoDemo}
      onOpenKnowledge={onOpenKnowledge}
    />
  ) : null;
}
