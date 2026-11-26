import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useFactoryRead, readPath } from "./factory-feed";
import {
  ActionNotice,
  Badge,
  ContextHelp,
  Empty,
  EntryButton,
  Facts,
  Filter,
  Pagination,
  ReadNotice,
  useAction,
} from "./FactoryControls";
import { runtimeHelpId, runtimeName } from "./factory-help";
import { factoryApi } from "./factory-client";
import { AssemblyReview } from "./AssemblyTrials";
import {
  bytes,
  stateName,
  when,
  type Activity,
  type Agent,
  type AssetPage,
  type Delivery,
  type OpenAgent,
  type OpenTask,
  type Page,
  type Quality,
  type RuntimePage,
  type Source,
  type Task,
} from "./factory-model";

const pageSize = 20;
const states: [string, string][] = [
  ["in_progress", "进行中（全部在办）"],
  ["", "全部状态"],
  ["active_nodes", "有正在执行的节点"],
  ...[
    "received",
    "planning",
    "planned",
    "running",
    "awaiting_user_input",
    "awaiting_review",
    "accepted",
    "failed",
    "planning_failed",
    "stopping",
    "cancelled",
  ].map((s) => [s, stateName(s)] as [string, string]),
];
function useList() {
  const [offset, setOffset] = useState(0);
  const [value, setValue] = useState("");
  return {
    offset,
    setOffset,
    value,
    setValue: (v: string) => {
      setValue(v);
      setOffset(0);
    },
    params: { limit: pageSize, offset },
  };
}
export function TaskList({
  revision,
  onTask,
  source,
  agentId,
  version,
  initialState = "",
  title,
}: {
  revision: number;
  onTask: OpenTask;
  source?: string;
  agentId?: string;
  version?: string;
  initialState?: string;
  title?: string;
}) {
  const [filter, setFilter] = useState(initialState);
  const list = useList();
  const area =
    filter === "active_nodes"
      ? "line"
      : filter === "in_progress"
        ? "control"
        : undefined;
  const read = useFactoryRead<Page<Task>>(
    readPath("tasks", {
      ...list.params,
      area,
      sourceSystem: source,
      agentId,
      version,
      state: area ? undefined : filter,
    }),
    revision,
  );
  return (
    <section className="live-section">
      {title && <h3>{title}</h3>}
      <Filter
        label="工单状态"
        value={filter}
        options={states}
        onChange={(v) => {
          list.setOffset(0);
          setFilter(v);
        }}
      />
      <ReadNotice read={read} />
      {read.data && (
        <>
          <div className="live-count">共 {read.data.total} 张工单</div>
          <div className="live-list">
            {read.data.items.map((t) => (
              <EntryButton
                key={t.id}
                title={t.goal}
                badge={t.state}
                onClick={() => onTask(t.taskId, t.goal)}
                meta={[
                  stateName(t.sourceSystem),
                  t.planVersion
                    ? "计划 v" + t.planVersion
                    : t.planMode === "direct_answer"
                      ? "直接答复"
                      : null,
                  when(t.updatedAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
            {!read.data.items.length && <Empty>没有符合条件的工单</Empty>}
          </div>
          <Pagination
            {...list}
            total={read.data.total}
            limit={pageSize}
            onChange={list.setOffset}
          />
        </>
      )}
    </section>
  );
}
const intakeTabs = [
  ["tasks", "需求列表"],
  ["sources", "接入情况"],
] as const;
type IntakeTab = (typeof intakeTabs)[number][0];
export function Intake({
  revision,
  onTask,
}: {
  revision: number;
  onTask: OpenTask;
}) {
  const [tab, setTab] = useState<IntakeTab>("tasks");
  const [source, setSource] = useState<Pick<
    Source,
    "id" | "displayName"
  > | null>(null);
  const tabRefs = useRef<Partial<Record<IntakeTab, HTMLButtonElement | null>>>(
    {},
  );
  const id = useId();
  const list = useList();
  const read = useFactoryRead<Page<Source>>(
    tab === "sources" ? readPath("sources", list.params) : null,
    revision,
  );
  function activate(next: IntakeTab) {
    setTab(next);
    tabRefs.current[next]?.focus({ preventScroll: true });
  }
  function onKey(event: KeyboardEvent<HTMLButtonElement>, current: IntakeTab) {
    let next: IntakeTab;
    if (event.key === "Home") next = "tasks";
    else if (event.key === "End") next = "sources";
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      next = current === "tasks" ? "sources" : "tasks";
    else return;
    event.preventDefault();
    activate(next);
  }
  return (
    <>
      <div role="tablist" className="live-tabs" aria-label="需求接待大厅">
        {intakeTabs.map(([value, label]) => (
          <button
            type="button"
            role="tab"
            key={value}
            id={id + "-" + value}
            aria-controls={id + "-panel-" + value}
            aria-selected={value === tab}
            tabIndex={value === tab ? 0 : -1}
            ref={(el) => {
              tabRefs.current[value] = el;
            }}
            onKeyDown={(e) => onKey(e, value)}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id={id + "-panel-tasks"}
        role="tabpanel"
        aria-labelledby={id + "-tasks"}
        hidden={tab !== "tasks"}
      >
        {tab === "tasks" && (
          <>
            {source && (
              <div className="live-bar">
                <span>接入渠道 · {source.displayName}</span>
                <button type="button" onClick={() => setSource(null)}>
                  查看所有渠道
                </button>
              </div>
            )}
            <TaskList
              key={source?.id ?? ""}
              title={source ? source.displayName + "的需求" : "所有渠道的需求"}
              source={source?.id}
              revision={revision}
              onTask={onTask}
            />
          </>
        )}
      </div>
      <div
        id={id + "-panel-sources"}
        role="tabpanel"
        aria-labelledby={id + "-sources"}
        hidden={tab !== "sources"}
      >
        {tab === "sources" && (
          <>
            <ReadNotice read={read} />
            {read.data && (
              <>
                <div className="live-list">
                  {read.data.items.map((s) => (
                    <button
                      className="live-entry"
                      type="button"
                      key={s.id}
                      aria-label={"查看" + s.displayName + "的需求"}
                      onClick={() => {
                        setSource({ id: s.id, displayName: s.displayName });
                        activate("tasks");
                      }}
                    >
                      <strong>{s.displayName}</strong>
                      <Badge value={s.status} />
                      <small>
                        {s.taskCount} 张工单
                        {s.lastReceivedAt
                          ? " · 最近接收 " + when(s.lastReceivedAt)
                          : ""}
                      </small>
                    </button>
                  ))}
                  {!read.data.items.length && <Empty>没有接入渠道记录</Empty>}
                </div>
                <Pagination
                  {...list}
                  limit={pageSize}
                  total={read.data.total}
                  onChange={list.setOffset}
                />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export { AgentCatalog, AgentVersions } from "./AgentCatalog";
export function AgentDetail({
  id,
  version,
  revision,
  onTask,
  onChange,
  stale,
  onBased,
  onTest,
}: {
  id: string;
  version: string;
  revision: number;
  onTask: OpenTask;
  onChange: () => void;
  stale: boolean;
  onBased?: (agent: Agent) => Promise<void>;
  onTest?: (record: NonNullable<Agent["assembly"]>) => void;
}) {
  const read = useFactoryRead<Page<Agent>>(
    readPath("agents", { agentId: id, version, limit: 1 }),
    revision,
  );
  const agent = read.data?.items[0],
    action = useAction(onChange);
  const [confirm, setConfirm] = useState<
    "offline" | "delete" | "version" | null
  >(null);
  const [removed, setRemoved] = useState(false),
    [deleteAttempted, setDeleteAttempted] = useState(false);
  const refreshAgent = () => {
    read.retry();
    onChange();
  };
  const resourceId = encodeURIComponent(id),
    resourceVersion = encodeURIComponent(version);
  const disabled = action.busy || stale || Boolean(read.error);
  const assembly = agent?.assembly;
  const deleting = agent?.status === "deleting";
  const identity = useFactoryRead<{ status: string }>(
    deleting ? `/v1/factory/agents/${resourceId}/status` : null,
    revision,
  );
  const deletingAll = identity.data?.status === "deleting";
  async function removeAgent() {
    setDeleteAttempted(true);
    try {
      const result = await factoryApi.post<{
        agentId: string;
        status: string;
        versionCount: number;
      }>(`/v1/factory/agents/${resourceId}/delete`, {});
      if (result.agentId !== id || result.status !== "deleted")
        throw new Error("未能确认删除结果，请刷新智能体状态");
      setRemoved(true);
      setConfirm(null);
      return (
        "已删除智能体 " +
        id +
        " 的全部 " +
        result.versionCount +
        " 个登记版本。"
      );
    } finally {
      read.retry();
    }
  }
  const canApprove =
    agent &&
    ["pending_review", "offline", "self_check_failed"].includes(agent.status);
  return (
    <>
      <ReadNotice read={read} />
      {agent && !removed && (
        <>
          <div className="live-summary">
            <h3>{agent.displayName}</h3>
            {onBased && !deleting && (
              <button
                className="ui-action ui-primary ui-small"
                type="button"
                disabled={disabled || confirm !== null}
                onClick={() => void action.run(() => onBased(agent))}
              >
                升级智能体
              </button>
            )}
            <Badge value={agent.status} version />
            {agent.description && <p>{agent.description}</p>}
            <Facts
              rows={[
                ["标识", id],
                ["版本", version],
                [
                  "运行环境",
                  <>
                    {runtimeName(agent.runtime)}
                    <ContextHelp id={runtimeHelpId(agent.runtime)} />
                  </>,
                ],
                ["工作实例", agent.runningCount],
                ["登记时间", when(agent.createdAt)],
                ["审核时间", when(agent.approvedAt)],
              ]}
            />
          </div>
          <h3>能力</h3>
          <ul className="live-bullets">
            {agent.capabilities.map((c) => (
              <li key={c.name}>
                <b>{c.name}</b>
                {c.description && <p>{c.description}</p>}
              </li>
            ))}
          </ul>
          {agent.integrityIssue === "assembly_digest_mismatch" && (
            <p className="live-notice error" role="alert">
              节点包内容与发布摘要不一致。请重新生成并测试智能体。
            </p>
          )}
          {agent.integrityIssue === "package_digest_mismatch" && (
            <p className="live-notice error" role="alert">
              当前程序包与发布时的内容不一致。请恢复已登记的程序包，或从完整的原版本发布新版。
            </p>
          )}
          {agent.assembly && (
            <AssemblyReview record={agent.assembly} onTask={onTask} />
          )}
          <div className="fc-actions">
            {assembly && onTest && (
              <button
                type="button"
                className="ui-action ui-small"
                onClick={() => onTest(assembly)}
              >
                打开版本测试
              </button>
            )}
            {canApprove && (
              <button
                className="ui-action ui-primary"
                disabled={
                  disabled ||
                  confirm !== null ||
                  agent.integrityIssue === "assembly_digest_mismatch"
                }
                onClick={() =>
                  void action.run(async () => {
                    await factoryApi.post(
                      `/v1/agents/${resourceId}/versions/${resourceVersion}/approve`,
                      {},
                    );
                    return "已提交审核与自检，请查看最新版本状态";
                  })
                }
              >
                {agent.status === "offline"
                  ? "重新审核上线"
                  : agent.status === "self_check_failed"
                    ? "重新自检"
                    : "审核并上线"}
              </button>
            )}
            {agent.status === "ready" && !confirm && (
              <button
                className="ui-action ui-quiet ui-small"
                disabled={disabled}
                onClick={() => setConfirm("offline")}
              >
                下线版本
              </button>
            )}
          </div>
          {deleting && <ReadNotice read={identity} />}
          {(!deleting || identity.data?.status === "active") && !confirm && (
            <button
              type="button"
              className="ui-action ui-small ui-danger live-danger-link"
              disabled={disabled}
              onClick={() => setConfirm("version")}
            >
              {deleting ? "重试删除此版本" : "删除此版本"}
            </button>
          )}
          {confirm === "version" && (
            <section
              aria-label="删除指定版本确认"
              className="live-confirm live-danger-confirm"
            >
              <strong>
                删除 {id} v{version}？
              </strong>
              <p>
                中台将检查绑定到该版本的工单和调用，撤销该版本在节点的启动资格。
              </p>
              <div className="fc-actions">
                <button
                  type="button"
                  className="ui-action ui-danger ui-small"
                  disabled={disabled}
                  onClick={() =>
                    void action.run(async () => {
                      try {
                        const result = await factoryApi.post<{
                          agentId: string;
                          version: string;
                          status: string;
                        }>(
                          `/v1/factory/agents/${resourceId}/versions/${resourceVersion}/delete`,
                          {},
                        );
                        if (
                          result.agentId === id &&
                          result.status === "deleting"
                        ) {
                          setConfirm(null);
                          return "智能体正在撤销全部版本，请查看最新状态。";
                        }
                        if (
                          result.agentId !== id ||
                          result.version !== version ||
                          result.status !== "deleted"
                        )
                          throw Error("中台未确认指定版本已删除，请刷新核对。");
                        setRemoved(true);
                        setConfirm(null);
                        return "已删除 " + id + " v" + version + "。";
                      } finally {
                        read.retry();
                      }
                    })
                  }
                >
                  确认删除此版本
                </button>
                <button
                  type="button"
                  className="ui-action ui-small"
                  disabled={action.busy}
                  onClick={() => setConfirm(null)}
                >
                  取消
                </button>
              </div>
            </section>
          )}
          {confirm === "offline" && agent.status === "ready" && (
            <div className="live-confirm">
              <p>
                下线 v{version} 后将停止分配新节点。已启动的实例可继续完成。
                <ContextHelp id="agent-version" label="解释：下线版本" />
              </p>
              <div className="fc-actions">
                <button
                  className="ui-action ui-danger ui-small"
                  disabled={disabled}
                  onClick={() =>
                    void action.run(async () => {
                      await factoryApi.post(
                        `/v1/factory/agents/${resourceId}/versions/${resourceVersion}/offline`,
                        {},
                      );
                      setConfirm(null);
                      return "版本已下线";
                    })
                  }
                >
                  确认下线
                </button>
                <button
                  className="ui-action ui-quiet ui-small"
                  onClick={() => setConfirm(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {!removed && agent && !confirm && (
        <button
          type="button"
          className="ui-action ui-small ui-danger live-danger-link"
          disabled={disabled}
          onClick={() => setConfirm("delete")}
        >
          {deletingAll
            ? "重试删除智能体（全部版本）"
            : "删除智能体（全部版本）"}
        </button>
      )}
      {!removed && confirm === "delete" && (agent || deleteAttempted) && (
        <section
          aria-label="删除智能体确认"
          className="live-confirm live-danger-confirm"
        >
          <strong>删除智能体 {agent?.displayName ?? id} 的全部版本？</strong>
          <small>智能体标识 {id}</small>
          <VersionImpact id={id} revision={revision} />
          <p>
            确认后中台将移除该智能体所有版本的登记并撤销节点发布。历史工单、执行记录和已归档的成果保留。在用实例或未结束的绑定工单会阻止删除。
          </p>
          <div className="fc-actions">
            <button
              type="button"
              className="ui-action ui-danger ui-small"
              disabled={disabled}
              onClick={() => void action.run(removeAgent)}
            >
              确认删除全部版本
            </button>
            <button
              type="button"
              className="ui-action ui-quiet ui-small"
              disabled={action.busy}
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
          </div>
        </section>
      )}
      <ActionNotice action={action} />
      {action.error && (
        <button
          type="button"
          className="ui-action ui-small"
          onClick={refreshAgent}
        >
          刷新智能体状态
        </button>
      )}
      {!removed && read.data && !agent && <Empty>中台未找到这个版本</Empty>}
      {agent && !removed && (
        <TaskList
          key={id + version}
          title="使用此版本的工单"
          revision={revision}
          agentId={id}
          version={version}
          onTask={onTask}
        />
      )}
    </>
  );
}
function VersionImpact({ id, revision }: { id: string; revision: number }) {
  const [offset, setOffset] = useState(0);
  const read = useFactoryRead<Page<Agent>>(
    readPath("agents", { agentId: id, offset, limit: pageSize }),
    revision,
  );
  return (
    <>
      <ReadNotice read={read} />
      {read.data && (
        <>
          <p>
            涉及 {read.data.total} 个登记版本 ·{" "}
            {read.data.items.map((a) => "v" + a.version).join("、")}
          </p>
          <Pagination
            total={read.data.total}
            limit={pageSize}
            offset={offset}
            onChange={setOffset}
          />
        </>
      )}
    </>
  );
}
export function QualityDesk({
  revision,
  onTask,
  initialFilter = "pending_quality",
}: {
  revision: number;
  onTask: OpenTask;
  initialFilter?: string;
}) {
  const [status, setStatus] = useState(initialFilter),
    list = useList();
  const read = useFactoryRead<Page<Quality>>(
    readPath("quality", { ...list.params, status }),
    revision,
  );
  return (
    <>
      <Filter
        label="质检结果"
        value={status}
        options={[
          ["pending_quality", "待质检"],
          ["", "全部记录"],
          ["pending_review", "待人工验收"],
          ["automatic_passed", "自动通过"],
          ["failed", "质检失败"],
          ["checking", "核验中"],
          ["rework", "返工"],
          ["supplement", "补查"],
          ["accepted", "已验收"],
        ]}
        onChange={(v) => {
          setStatus(v);
          list.setOffset(0);
        }}
      />
      <ReadNotice read={read} />
      {read.data && (
        <>
          <div className="live-count">共 {read.data.total} 张工单</div>
          <div className="live-list">
            {read.data.items.map((q) => (
              <EntryButton
                key={q.id}
                title={q.goal}
                badge={q.status}
                onClick={() => onTask(q.taskId, q.goal, "quality")}
                meta={[
                  q.acceptedBy
                    ? stateName(q.acceptedBy)
                    : stateName(q.acceptanceMode),
                  q.round ? "第 " + q.round + " 轮" : null,
                  "核验 " + stateName(q.verdict),
                  "缺项 " + q.missingCount + " · 待核实 " + q.uncertainCount,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
            {!read.data.items.length && <Empty>没有符合条件的质检记录</Empty>}
          </div>
          <Pagination
            {...list}
            limit={pageSize}
            total={read.data.total}
            onChange={list.setOffset}
          />
        </>
      )}
    </>
  );
}
export function Assets({
  revision,
  onKnowledge,
}: {
  revision: number;
  onKnowledge: () => void;
}) {
  const list = useList(),
    read = useFactoryRead<AssetPage>(readPath("assets", list.params), revision);
  return (
    <>
      <div className="live-bar">
        <h3>RAGFlow 知识库</h3>
        <button type="button" onClick={onKnowledge}>
          打开栖知知识库
        </button>
      </div>
      <ReadNotice read={read} />
      {read.data && (
        <>
          <Badge value={read.data.connection.status} />
          <p className="live-subtle">{read.data.connection.message}</p>
          <Facts
            rows={[
              ["连接检查", when(read.data.connection.observedAt)],
              ["本厂配置", read.data.connection.configuredCount],
              ["可读取", read.data.connection.visibleCount ?? "未知"],
              [
                "未能读取的数据集",
                read.data.connection.missingDatasetIds?.join("、"),
              ],
              ["任务资料", read.data.metrics.inputCount],
              ["归档制品", read.data.metrics.artifactCount],
              ["任务会话", read.data.metrics.sessionCount],
            ]}
          />
          <h3>数据集</h3>
          <div className="live-list">
            {read.data.items.map((s) => (
              <article className="live-card" key={s.id}>
                <strong>{s.name}</strong>
                <small>{s.id}</small>
                <Facts
                  rows={[
                    ["中台检索", s.configured ? "已选用" : "未选用"],
                    ["文档", s.documentCount ?? "未返回"],
                    ["分块", s.chunkCount ?? "未返回"],
                  ]}
                />
              </article>
            ))}
            {!read.data.items.length && (
              <Empty>
                {read.data.connection.status === "connected"
                  ? "RAGFlow 没有返回数据集"
                  : "知识库目录暂时不可用"}
              </Empty>
            )}
          </div>
          {read.data.total !== null && (
            <Pagination
              {...list}
              limit={pageSize}
              total={read.data.total}
              onChange={list.setOffset}
            />
          )}
        </>
      )}
    </>
  );
}
export function Runtimes({
  revision,
  onTask,
  onAgent,
}: {
  revision: number;
  onTask: OpenTask;
  onAgent: OpenAgent;
}) {
  const [runtime, setRuntime] = useState(""),
    list = useList();
  const read = useFactoryRead<RuntimePage>(
    readPath("runtimes", { ...list.params, runtime, state: list.value }),
    revision,
  );
  return (
    <>
      <h3>
        运行环境与负载
        <ContextHelp id="runtime" />
      </h3>
      <ReadNotice read={read} />
      {read.data && (
        <div className="live-list">
          {read.data.inventory.map((r) => (
            <article className="live-card" key={r.id}>
              <div className="live-bar">
                <strong>
                  {runtimeName(r.id)}
                  <ContextHelp id={runtimeHelpId(r.id)} />
                </strong>
                <button
                  aria-pressed={runtime === r.id}
                  onClick={() => {
                    setRuntime(runtime === r.id ? "" : r.id);
                    list.setOffset(0);
                  }}
                >
                  {runtime === r.id ? "清除筛选" : "筛选此环境"}
                </button>
              </div>
              <small>
                就绪版本 {r.readyVersionCount} · 执行中 {r.activeCount} · 规划中{" "}
                {r.planningCount} · 累计执行 {r.attemptCount}
              </small>
            </article>
          ))}
          {!read.data.inventory.length && <Empty>没有已登记的运行环境</Empty>}
        </div>
      )}
      <h3>
        执行实例{runtime ? " · " + runtimeName(runtime) : ""}
        <ContextHelp id="execution-instance" />
      </h3>
      <Filter
        label="实例状态"
        value={list.value}
        onChange={list.setValue}
        options={[
          ["", "全部记录"],
          ["leased", "运行中"],
          ["completed", "已完成"],
          ["failed", "失败"],
          ["interrupted", "已中断"],
        ]}
      />
      {read.data && (
        <>
          <div className="live-list">
            {read.data.items.map((r) => (
              <article key={r.id} className="live-card">
                <strong>{r.goal}</strong>
                <Badge value={r.state} />
                <Facts
                  rows={[
                    ["实例", r.instanceId],
                    [
                      "运行环境",
                      <>
                        {runtimeName(r.runtime)}
                        <ContextHelp id={runtimeHelpId(r.runtime)} />
                      </>,
                    ],
                    ["节点", r.nodeKey],
                    [
                      "最近心跳",
                      <>
                        {when(r.lastHeartbeatAt)}
                        <ContextHelp id="heartbeat" />
                      </>,
                    ],
                    ["运行单元", r.unitName],
                    [
                      "资源采样",
                      r.metrics.available
                        ? when(r.metrics.observedAt)
                        : "暂无采样",
                    ],
                    [
                      "累计 CPU",
                      r.metrics.cpuUsageUsec == null
                        ? "未采集"
                        : (r.metrics.cpuUsageUsec / 1000000).toFixed(3) + " 秒",
                    ],
                    ["内存占用", bytes(r.metrics.memoryBytes)],
                    ["进程数", r.metrics.pidsCurrent ?? "未采集"],
                    [
                      "采集来源",
                      r.metrics.source && stateName(r.metrics.source),
                    ],
                    [
                      "采集说明",
                      r.metrics.reason && stateName(r.metrics.reason),
                    ],
                  ]}
                />
                <div className="fc-actions">
                  <button onClick={() => onTask(r.taskId, r.goal)}>
                    查看工单
                  </button>
                  {r.agentId && r.agentVersion && (
                    <button onClick={() => onAgent(r.agentId, r.agentVersion)}>
                      {r.agentId} · v{r.agentVersion}
                    </button>
                  )}
                </div>
              </article>
            ))}
            {!read.data.items.length && <Empty>没有符合条件的实例</Empty>}
          </div>
          <Pagination
            {...list}
            limit={pageSize}
            total={read.data.total}
            onChange={list.setOffset}
          />
        </>
      )}
    </>
  );
}
export function Monitor({
  revision,
  onTask,
}: {
  revision: number;
  onTask: OpenTask;
}) {
  const [source, setSource] = useState(""),
    [kind, setKind] = useState(""),
    [custom, setCustom] = useState("");
  const list = useList();
  const read = useFactoryRead<Page<Activity>>(
    readPath("monitor", { ...list.params, source, kind }),
    revision,
  );
  return (
    <>
      <Filter
        label="上报方"
        value={source}
        options={[
          ["", "全部上报方"],
          ["control_plane", "中台"],
          ["agent", "智能体"],
          ["node_manager", "节点管理器"],
        ]}
        onChange={(v) => {
          setSource(v);
          list.setOffset(0);
        }}
      />
      <form
        className="live-search"
        onSubmit={(e) => {
          e.preventDefault();
          setKind(custom.trim());
          list.setOffset(0);
        }}
      >
        <label>
          事件类型
          <input
            placeholder="全部类型"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <button>筛选</button>
      </form>
      <div
        className="fc-actions live-monitor-filters"
        aria-label="常用事件类型"
      >
        {(
          [
            ["agent_heartbeat", "心跳"],
            ["agent_liveness_lost", "心跳超时"],
            ["agent_progress", "执行进度"],
            ["agent_output", "智能体输出"],
          ] as const
        ).map(([type, label]) => (
          <button
            type="button"
            key={type}
            aria-pressed={kind === type}
            onClick={() => {
              const next = kind === type ? "" : type;
              setKind(next);
              setCustom(next);
              list.setOffset(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {kind && (
        <button
          className="fc-back"
          onClick={() => {
            setKind("");
            setCustom("");
            list.setOffset(0);
          }}
        >
          清除事件筛选
        </button>
      )}
      <ReadNotice read={read} />
      {read.data && (
        <>
          <div className="live-count">共 {read.data.total} 条事件</div>
          <div className="live-list">
            {read.data.items.map((e) => (
              <article className="live-card" key={e.id}>
                <strong>{e.message}</strong>
                <small>
                  {when(e.occurredAt)} · {stateName(e.source)} · {e.kind}
                </small>
                <Badge value={e.state} />
                {e.detail?.instanceId && (
                  <small>实例 {e.detail.instanceId}</small>
                )}
                {e.detail?.stage && <p>{e.detail.stage}</p>}
                {e.detail?.text && (
                  <details>
                    <summary>上报内容</summary>
                    <pre>{e.detail.text}</pre>
                  </details>
                )}
                <button onClick={() => onTask(e.taskId, e.taskId, "monitor")}>
                  查看工单时间线
                </button>
              </article>
            ))}
            {!read.data.items.length && <Empty>没有符合条件的监控事件</Empty>}
          </div>
          <Pagination
            {...list}
            limit={pageSize}
            total={read.data.total}
            onChange={list.setOffset}
          />
        </>
      )}
    </>
  );
}
export function Deliveries({
  revision,
  onTask,
}: {
  revision: number;
  onTask: OpenTask;
}) {
  const list = useList();
  const read = useFactoryRead<Page<Delivery>>(
    readPath("deliveries", list.params),
    revision,
  );
  return (
    <>
      <h3>已验收的成果</h3>
      <ReadNotice read={read} />
      {read.data && (
        <>
          <div className="live-count">共 {read.data.total} 张交付单</div>
          <div className="live-list">
            {read.data.items.map((d) => (
              <EntryButton
                key={d.id}
                title={d.goal}
                meta={when(d.updatedAt) + " · " + d.artifactCount + " 个制品"}
                badge={d.state}
                onClick={() => onTask(d.taskId, d.goal, "delivery")}
              >
                {d.answer && <small className="live-excerpt">{d.answer}</small>}
              </EntryButton>
            ))}
            {!read.data.items.length && <Empty>尚无已验收的交付</Empty>}
          </div>
          <Pagination
            {...list}
            limit={pageSize}
            total={read.data.total}
            onChange={list.setOffset}
          />
        </>
      )}
    </>
  );
}
