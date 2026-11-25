import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AgentVersions } from "./FactoryAreas";
import { Empty, EntryButton, Pagination, ReadNotice } from "./FactoryControls";
import { readPath, useFactoryRead } from "./factory-feed";
import {
  when,
  type OpenAgent,
  type OpenTask,
  type Page,
  type RuntimeJob,
} from "./factory-model";

const tabs = [
  ["running", "正在运行"],
  ["ready", "已上线"],
  ["pending_review", "待审核"],
] as const;
export type LineTab = (typeof tabs)[number][0];
export type LineView = { tab: LineTab; offset: number };
type LineInstance = Pick<
  RuntimeJob,
  | "instanceId"
  | "taskId"
  | "goal"
  | "nodeKey"
  | "agentId"
  | "agentVersion"
  | "state"
  | "lastHeartbeatAt"
> & { displayName: string; testRun: boolean };

export function LineTabs({
  tab,
  onTab,
  children,
}: {
  tab: LineTab;
  onTab: (tab: LineTab) => void;
  children: ReactNode;
}) {
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (index + tabs.length - 1) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onTab(tabs[next][0]);
    buttons.current[next]?.focus({ preventScroll: true });
  }
  return (
    <>
      <div
        role="tablist"
        aria-label="智能体生产线"
        aria-orientation="horizontal"
        className="fc-line-tabs"
      >
        {tabs.map(([value, label], index) => (
          <button
            type="button"
            role="tab"
            key={value}
            id={id + "-" + value}
            aria-controls={id + "-panel-" + value}
            aria-selected={value === tab}
            tabIndex={value === tab ? 0 : -1}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            onKeyDown={(event) => onKey(event, index)}
            onClick={() => onTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tabs.map(([value]) => (
        <div
          key={value}
          role="tabpanel"
          id={id + "-panel-" + value}
          aria-labelledby={id + "-" + value}
          hidden={value !== tab}
        >
          {value === tab && children}
        </div>
      ))}
    </>
  );
}

function RunningInstances({
  revision,
  offset,
  onPage,
  onTask,
}: {
  revision: number;
  offset: number;
  onPage: (offset: number) => void;
  onTask: OpenTask;
}) {
  const read = useFactoryRead<Page<LineInstance>>(
    readPath("runtimes", { area: "line", state: "active", limit: 20, offset }),
    revision,
  );
  // Older servers ignore the area filter and return the general runtime inventory.
  if (read.data && "inventory" in read.data)
    return (
      <ReadNotice
        read={{
          ...read,
          data: null,
          error: read.error || "当前中台未提供生产线运行实例清单。",
        }}
      />
    );
  return (
    <>
      <ReadNotice read={read} />
      {read.data && (
        <>
          <div className="live-count">共 {read.data.total} 个运行实例</div>
          <div className="live-list">
            {read.data.items.map((instance) => (
              <EntryButton
                key={instance.instanceId}
                title={
                  (instance.displayName || instance.agentId) +
                  " · v" +
                  instance.agentVersion
                }
                meta={
                  (instance.testRun ? "测试工单 · " : "工单 · ") + instance.goal
                }
                badge={
                  instance.state === "stopping" ? instance.state : undefined
                }
                onClick={() =>
                  onTask(instance.taskId, instance.goal, "monitor")
                }
              >
                <small>
                  节点 {instance.nodeKey} · 实例 {instance.instanceId}
                </small>
                <small>
                  {instance.lastHeartbeatAt
                    ? "最近心跳 " + when(instance.lastHeartbeatAt)
                    : "尚未收到心跳"}
                </small>
              </EntryButton>
            ))}
            {read.data.total === 0 && <Empty>当前没有正在运行的实例</Empty>}
          </div>
          <Pagination
            limit={read.data.limit}
            offset={read.data.offset}
            total={read.data.total}
            onChange={onPage}
          />
        </>
      )}
    </>
  );
}

export function ProductionLine({
  revision,
  onTask,
  onAgent,
  view,
  onView,
}: {
  revision: number;
  onTask: OpenTask;
  onAgent: OpenAgent;
  view: LineView;
  onView: (view: LineView) => void;
}) {
  const paging = {
    revision,
    offset: view.offset,
    onPage: (offset: number) => onView({ ...view, offset }),
  };
  return (
    <LineTabs
      tab={view.tab}
      onTab={(tab) => {
        if (tab !== view.tab) onView({ tab, offset: 0 });
      }}
    >
      {view.tab === "running" ? (
        <RunningInstances {...paging} onTask={onTask} />
      ) : (
        <AgentVersions {...paging} status={view.tab} onAgent={onAgent} />
      )}
    </LineTabs>
  );
}
