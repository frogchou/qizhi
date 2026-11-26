import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ControlIcon } from "../../components/ControlIcon";
import {
  Badge,
  ContextHelp,
  Empty,
  Pagination,
  ReadNotice,
} from "./FactoryControls";
import { readPath, useFactoryRead } from "./factory-feed";
import { runtimeName } from "./factory-help";
import {
  stateName,
  type Agent,
  type OpenAgent,
  type Page,
} from "./factory-model";
import "./agent-catalog.css";

const statuses = [
  "",
  "ready",
  "pending_review",
  "offline",
  "self_check_failed",
  "working",
  "self_checking",
  "draining",
  "deleting",
];
const pageSize = 20;

export function AgentCatalog({
  revision,
  onAgent,
  initialFilter = "ready",
  active = true,
}: {
  revision: number;
  onAgent: OpenAgent;
  initialFilter?: string;
  active?: boolean;
}) {
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState(
    statuses.includes(initialFilter) ? initialFilter : "",
  );
  const [offset, setOffset] = useState(0);
  const [runtime, setRuntime] = useState("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    const term = text.trim();
    if (!active || composing || term === search) return;
    const timer = window.setTimeout(() => {
      setSearch(term);
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active, composing, search, text]);

  function applySearch() {
    setSearch(text.trim());
    setOffset(0);
  }
  function selectStatus(value: string) {
    if (value === status && search === text.trim()) return;
    setStatus(value);
    applySearch();
  }
  function resetFilters() {
    setText("");
    setSearch("");
    setRuntime("");
    setStatus("");
    setOffset(0);
    searchInput.current?.focus({ preventScroll: true });
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % statuses.length;
        break;
      case "ArrowLeft":
        next = (index + statuses.length - 1) % statuses.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = statuses.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectStatus(statuses[next]);
    tabRefs.current[next]?.focus({ preventScroll: true });
  }

  return (
    <section className="version-catalog" aria-labelledby={id + "-title"}>
      <h3 id={id + "-title"}>
        智能体版本
        <ContextHelp id="agent-version" />
      </h3>
      <div className="version-catalog-tools">
        <form
          role="search"
          aria-label="版本目录"
          onSubmit={(event) => {
            event.preventDefault();
            if (!composing) applySearch();
          }}
        >
          <label className="version-search">
            <ControlIcon name="search" />
            <input
              ref={searchInput}
              type="search"
              aria-label="搜索智能体版本"
              placeholder="搜索名称、标识、能力或版本号"
              maxLength={160}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            />
          </label>
          <button type="submit" className="ui-action ui-small">
            搜索
          </button>
        </form>
        <label className="version-runtime">
          运行环境
          <select
            value={runtime}
            onChange={(event) => {
              setRuntime(event.target.value);
              applySearch();
            }}
          >
            <option value="">全部环境</option>
            <option value="native">本地服务</option>
            <option value="codex">Codex</option>
            <option value="pi">Pi</option>
            <option value="unknown">未记录</option>
          </select>
        </label>
        <button
          type="button"
          className="ui-action ui-quiet ui-small"
          onClick={resetFilters}
          disabled={!text && !search && !status && !runtime}
        >
          重置筛选
        </button>
      </div>
      <div className="version-status-tabs" role="tablist" aria-label="版本状态">
        {statuses.map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            data-version-state={value}
            id={id + "-tab-" + index}
            aria-controls={id + "-panel-" + index}
            aria-selected={value === status}
            tabIndex={value === status ? 0 : -1}
            ref={(button) => {
              tabRefs.current[index] = button;
            }}
            onClick={() => selectStatus(value)}
            onKeyDown={(event) => navigate(event, index)}
          >
            {value && <i aria-hidden="true" />}
            {value ? stateName(value) : "全部版本"}
          </button>
        ))}
      </div>
      {statuses.map((value, index) => (
        <div
          key={value}
          role="tabpanel"
          id={id + "-panel-" + index}
          aria-labelledby={id + "-tab-" + index}
          hidden={value !== status}
        >
          {value === status && (
            <AgentVersions
              status={status}
              search={search}
              runtime={runtime}
              active={active}
              revision={revision}
              onAgent={onAgent}
              offset={offset}
              onPage={setOffset}
            />
          )}
        </div>
      ))}
    </section>
  );
}

export function AgentVersions({
  status,
  revision,
  onAgent,
  offset,
  onPage,
  search = "",
  runtime = "",
  active = true,
}: {
  status: string;
  revision: number;
  onAgent: OpenAgent;
  offset: number;
  onPage: (offset: number) => void;
  search?: string;
  runtime?: string;
  active?: boolean;
}) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<{ rowId: string; top?: number } | null>(null);
  const term = search.toLowerCase();
  const read = useFactoryRead<Page<Agent>>(
    active
      ? readPath("agents", { status, search, runtime, limit: pageSize, offset })
      : null,
    revision,
  );
  useLayoutEffect(() => {
    if (!active || !read.data || !returnTo.current || !list.current) return;
    const { rowId, top } = returnTo.current;
    returnTo.current = null;
    const row = document.getElementById(rowId);
    (row ?? list.current).focus({ preventScroll: true });
    const studio = list.current.closest<HTMLElement>(".assembly-studio");
    if (studio && top !== undefined) studio.scrollTop = top;
  }, [active, read.data]);

  return (
    <>
      <ReadNotice read={read} />
      {read.data && (
        <>
          <div className="live-count" role="status">
            共 {read.data.total} 个版本
          </div>
          <div className="live-list" ref={list} tabIndex={-1}>
            {read.data.items.map((agent) => {
              const capability =
                term &&
                agent.capabilities?.find(
                  (item) =>
                    item.name.toLowerCase().includes(term) ||
                    item.description?.toLowerCase().includes(term),
                );
              return (
                <button
                  type="button"
                  className="live-entry"
                  key={agent.id}
                  id={listId + "-" + agent.id}
                  onClick={(event) => {
                    const row = event.currentTarget;
                    returnTo.current = {
                      rowId: row.id,
                      top: row.closest<HTMLElement>(".assembly-studio")
                        ?.scrollTop,
                    };
                    onAgent(agent.agentId, agent.version);
                  }}
                >
                  <strong>{agent.displayName}</strong>
                  <small>
                    {agent.agentId} · v{agent.version} ·{" "}
                    {runtimeName(agent.runtime)} · {agent.runningCount}{" "}
                    个运行实例
                    {capability && (
                      <span className="version-match">
                        能力 · {capability.name}
                        {capability.description &&
                          " · " + capability.description}
                      </span>
                    )}
                  </small>
                  <Badge value={agent.status} version />
                </button>
              );
            })}
            {!read.data.total && (
              <Empty>
                {search || status || runtime
                  ? "没有符合条件的智能体版本"
                  : "尚无登记的智能体版本"}
              </Empty>
            )}
          </div>
          <Pagination
            offset={read.data.offset}
            limit={read.data.limit}
            total={read.data.total}
            onChange={onPage}
          />
        </>
      )}
    </>
  );
}
