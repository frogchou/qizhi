import { useEffect, useId, useRef, useState } from "react";
import { ControlIcon } from "../../components/ControlIcon";
import { factoryApi } from "./factory-client";
import { useFactoryRead } from "./factory-feed";
import { ActionNotice, Badge, ReadNotice, useAction } from "./FactoryControls";
import { AgentCatalog, AgentDetail } from "./FactoryAreas";
import { ResourceChoices } from "./AssemblyChoices";
import { AssemblyResources } from "./AssemblyResources";
import { AssemblyNavigation, type StudioTab } from "./AssemblyNavigation";
import { AssemblyBrief } from "./AssemblyBrief";
import { AssemblyTrials } from "./AssemblyTrials";
import {
  assemblies,
  createDraftFromVersion,
  draftPath,
  emptyConfig,
  generationOptions,
  editableVersionOptions,
  editingVersionLabel,
  pendingOperation,
  useRequestId,
  type AssemblyConfig,
  type AssemblyDraft,
  type AssemblyOptions,
  type DraftSummary,
  type TaskScope,
} from "./assembly-model";
import { factoryMessage, when, type OpenTask } from "./factory-model";
import "./assembly.css";
import "./assembly-studio.css";

type Editable = Pick<DraftSummary, "config" | "description">;
type Edit = Editable & { base: DraftSummary };
// Keep unsent fields separate when the user switches between control planes.
const sessionEdits = new Map<
  string,
  { edits: Record<string, Edit>; messages: Record<string, string> }
>();
const fresh: DraftSummary = {
  id: "",
  revision: 0,
  description: "",
  config: emptyConfig(),
};
const fields: [
  keyof Pick<
    AssemblyConfig,
    "displayName" | "agentId" | "version" | "capability"
  >,
  string,
  string,
][] = [
  ["displayName", "智能体名称", "例如，客户报价核对"],
  ["version", "目标发布版本", "例如 1.0.0"],
  ["agentId", "智能体标识", "例如 quote-desk"],
  ["capability", "主能力标识", "例如 enterprise.quote.reconcile"],
];
function readSelection(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function mergeManual(edit: Edit, current: DraftSummary): Edit {
  const changed = Object.entries(edit.config).filter(
    ([key, value]) =>
      JSON.stringify(value) !==
      JSON.stringify(edit.base.config[key as keyof AssemblyConfig]),
  );
  return {
    base: current,
    description:
      edit.description === edit.base.description
        ? current.description
        : edit.description,
    config: { ...current.config, ...Object.fromEntries(changed) },
  };
}
export function AssemblyWorkspace({
  active,
  endpoint,
  revision,
  connection,
  initialDraftId,
  onSettings,
  onChange,
  onTask,
  onNewTask,
}: {
  active: boolean;
  endpoint: string;
  revision: number;
  connection: "loading" | "live" | "reconnecting";
  initialDraftId?: string;
  onSettings: () => void;
  onChange: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
}) {
  const stale = connection !== "live";
  const storageKey = "qizhi.factory.assembly." + endpoint;
  const [id, setId] = useState(
      () => initialDraftId ?? readSelection(storageKey),
    ),
    [edits, setEdits] = useState<Record<string, Edit>>(
      () => sessionEdits.get(endpoint)?.edits ?? {},
    );
  const paneId = useId();
  const studio = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<StudioTab>("assemble"),
    [visited, setVisited] = useState({ manage: false, test: false }),
    [selectedBuild, setSelectedBuild] = useState<string>(),
    [conversationOpen, setConversationOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [version, setVersion] = useState<{ id: string; version: string } | null>(
      null,
    ),
    [library, setLibrary] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [messages, setMessages] = useState<Record<string, string>>(
      () => sessionEdits.get(endpoint)?.messages ?? {},
    ),
    [tick, setTick] = useState(0),
    [listTick, refreshList] = useState(0);
  const list = useFactoryRead<{ items: DraftSummary[] }>(
    assemblies,
    revision + listTick,
  );
  const detail = useFactoryRead<AssemblyDraft>(
    id ? draftPath(id) : null,
    revision + tick,
  );
  const options = useFactoryRead<AssemblyOptions>(
    `${assemblies}/options`,
    revision + listTick,
  );
  const action = useAction(),
    request = useRequestId();
  const current = detail.data ?? fresh,
    buffer = edits[id],
    edit = buffer ?? current;
  const conflict = Boolean(
    buffer && detail.data && buffer.base.revision !== detail.data.revision,
  );
  const archived = Boolean(detail.data?.deletedAt);
  const writable =
    !stale &&
    !action.busy &&
    !archived &&
    (!id || Boolean(detail.data && !detail.error));
  const hasDescription = Boolean(
    edit.description.trim() || edit.config.description.trim(),
  );
  const message = messages[id] ?? "";
  useEffect(() => {
    if (Object.keys(edits).length || Object.values(messages).some(Boolean))
      sessionEdits.set(endpoint, { edits, messages });
    else sessionEdits.delete(endpoint);
  }, [edits, messages, endpoint]);
  useEffect(() => {
    if (!active || !id || stale) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, 3500);
    return () => window.clearInterval(interval);
  }, [active, id, stale]);
  useEffect(() => {
    try {
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    } catch {
      /* Drafts can still be saved on the server without browser storage. */
    }
  }, [id, storageKey]);
  function navigate(next: StudioTab) {
    setTab(next);
    if (next !== "assemble")
      setVisited((old) => (old[next] ? old : { ...old, [next]: true }));
    if (studio.current) studio.current.scrollTop = 0;
    document
      .getElementById(paneId + "-tab-" + next)
      ?.focus({ preventScroll: true });
  }
  function panelProps(value: StudioTab) {
    return {
      role: "tabpanel",
      id: paneId + "-panel-" + value,
      "aria-labelledby": paneId + "-tab-" + value,
      hidden: tab !== value,
    };
  }
  function select(next: string, keepConversation = false) {
    if (next === id) return;
    setId(next);
    setSelectedBuild(undefined);
    if (!keepConversation) setConversationOpen(false);
    setHistoryOpen(false);
    setConfirmDelete(false);
  }
  function changed() {
    setTick((n) => n + 1);
    refreshList((n) => n + 1);
    onChange();
  }
  function update(partial: Partial<Editable>) {
    setEdits((old) => {
      const base = old[id]?.base ?? current;
      const next = { ...(old[id] ?? base), ...partial, base };
      if (
        next.description === base.description &&
        JSON.stringify(next.config) === JSON.stringify(base.config)
      ) {
        if (!old[id]) return old;
        const remaining = { ...old };
        delete remaining[id];
        return remaining;
      }
      return { ...old, [id]: next };
    });
  }
  function config<K extends keyof AssemblyConfig>(
    key: K,
    value: AssemblyConfig[K],
  ) {
    update({ config: { ...edit.config, [key]: value } });
  }
  async function save(): Promise<DraftSummary> {
    if (id && !detail.data)
      throw Error("当前编辑内容尚未加载，请重新读取后再保存。");
    if (conflict)
      throw Error("当前版本的编辑内容已在其他地方更新，请先核对修改。");
    if (id && !buffer) return current;
    const description =
      edit.description.trim() || edit.config.description.trim();
    if (!description) throw Error("请填写工作委托或智能体职责。");
    const editedConfig = {
      ...edit.config,
      criteria: edit.config.criteria.map((c) => c.trim()).filter(Boolean),
    };
    const result = await factoryApi.post<DraftSummary>(
      id ? `${draftPath(id)}/save` : assemblies,
      {
        description,
        ...(id
          ? { revision: buffer!.base.revision, config: editedConfig }
          : JSON.stringify(editedConfig) !== JSON.stringify(fresh.config)
            ? { config: editedConfig }
            : {}),
      },
    );
    if (!result?.id || typeof result.revision !== "number")
      throw Error("未确认保存成功，请重新读取当前编辑内容。");
    setEdits((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    if (!id) select(result.id, true);
    changed();
    return result;
  }
  function submit(kind: "suggest" | "generate", suggestion?: string) {
    void action.run(async () => {
      try {
        const saved = await save();
        const body = {
          revision: saved.revision,
          ...(kind === "suggest"
            ? {
                message:
                  suggestion?.trim() ||
                  edit.description.trim() ||
                  edit.config.description.trim(),
              }
            : {}),
        };
        const receipt = await factoryApi.post<{ id: string }>(
          `${draftPath(saved.id)}/${kind}`,
          { ...body, requestId: request.forPayload([saved.id, kind, body]) },
        );
        if (!receipt?.id)
          throw Error(
            kind === "generate"
              ? "尚未确认生成请求，请核对生成记录和可测试版本。"
              : "尚未确认助手已收到消息，请核对助手记录。",
          );
        request.confirmed();
        if (kind === "suggest" && message.trim() === suggestion?.trim())
          setMessages((old) => ({ ...old, [id]: "" }));
        if (kind === "suggest") setConversationOpen(true);
        return kind === "generate"
          ? "已提交生成请求，可在生成记录中查看进度。"
          : "已提交给装配助手。";
      } finally {
        changed();
      }
    });
  }
  const operations =
    detail.data?.operations.filter((o) => o.kind !== "trial") ?? [];
  const waiting = operations.some(pendingOperation);
  const resourceCount =
    edit.config.skills.length +
    edit.config.mcpTools.length +
    edit.config.capabilities.length +
    edit.config.datasetIds.length;
  const canGenerate = writable && hasDescription && !conflict && !waiting;
  const actionsLocked = action.busy || archived;
  const versions = editableVersionOptions(
    (list.data?.items ?? []).map((draft) => ({
      ...draft,
      config:
        tab === "test"
          ? draft.config
          : (edits[draft.id]?.config ?? draft.config),
    })),
    tab === "test" ? "" : "编辑中",
  );
  const newVersion = edits[""]?.config;
  const latest = generationOptions(detail.data?.candidates ?? [])[0]?.candidate;
  const generating = operations.some(
    (op) => op.kind === "generate" && pendingOperation(op),
  );
  const editChanged =
    Boolean(buffer) || (latest && latest.revision !== current.revision);
  return (
    <section
      ref={studio}
      className="fc fc-live assembly-studio"
      aria-label="智能体装配"
      hidden={!active}
    >
      <div className="studio-shell">
        <header className="studio-header">
          <h1>智能体装配</h1>
          <div className="studio-tools">
            <button
              type="button"
              className="ui-action"
              onClick={() => setLibrary(true)}
            >
              <ControlIcon name="layers" /> 精选资源管理
            </button>
            <button
              type="button"
              className="ui-action ui-quiet studio-connection"
              title={endpoint || "连接设置"}
              aria-label="连接设置"
              onClick={onSettings}
            >
              <i data-state={connection} aria-hidden="true" />
              {connection === "live"
                ? "中台已连接"
                : connection === "loading"
                  ? "正在连接"
                  : "连接中断"}
              <ControlIcon name="sliders" size={14} />
            </button>
          </div>
        </header>
        <AssemblyNavigation id={paneId} tab={tab} onSelect={navigate} />
        {connection === "reconnecting" && (
          <p className="live-notice" role="status">
            中台连接已中断。当前编辑会保留，恢复后可提交。
          </p>
        )}
        {tab !== "manage" && (
          <div className="studio-command">
            <label className="assembly-field studio-draft">
              智能体与版本
              <select
                aria-label="智能体与版本"
                value={id}
                disabled={action.busy}
                onChange={(e) => select(e.target.value)}
              >
                <option value="">
                  {tab === "test"
                    ? "选择要测试的智能体"
                    : newVersion
                      ? "新建 · " + editingVersionLabel(newVersion)
                      : "新建智能体"}
                </option>
                {id && !versions.some((v) => v.id === id) && (
                  <option value={id}>
                    {detail.data
                      ? editingVersionLabel(
                          edit.config,
                          archived ? "已归档" : tab === "test" ? "" : "编辑中",
                        )
                      : "正在读取所选版本"}
                  </option>
                )}
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="studio-save-state">
              {tab === "assemble" &&
                (buffer
                  ? "有未保存修改"
                  : id && detail.data
                    ? "修改已保存"
                    : "")}
            </span>
          </div>
        )}
        {tab !== "test" && <ActionNotice action={action} />}
        <ReadNotice read={list} />
        {id && tab !== "manage" && <ReadNotice read={detail} />}
        <section {...panelProps("assemble")}>
          {archived && (
            <p className="live-notice">
              此编辑记录已删除，仍可查看已生成的版本和测试记录。
            </p>
          )}
          {conflict && detail.data && buffer && (
            <section className="live-confirm" role="alert">
              <p>
                当前版本的编辑内容已在其他地方更新。你可以合并本地修改，也可以使用中台已保存的内容。
              </p>
              <div className="fc-actions">
                <button
                  className="ui-action ui-small"
                  onClick={() =>
                    setEdits({
                      ...edits,
                      [id]: mergeManual(buffer, detail.data!),
                    })
                  }
                >
                  合并我的改动
                </button>
                <button
                  className="ui-action ui-small"
                  onClick={() =>
                    setEdits((old) => {
                      const next = { ...old };
                      delete next[id];
                      return next;
                    })
                  }
                >
                  使用中台已保存的内容
                </button>
              </div>
            </section>
          )}
          {id && !detail.data ? null : (
            <>
              <AssemblyBrief
                description={edit.description}
                reply={message}
                messages={detail.data?.messages ?? []}
                canSuggest={canGenerate}
                locked={actionsLocked}
                open={conversationOpen}
                onOpen={setConversationOpen}
                onDescription={(description) => update({ description })}
                onReply={(text) =>
                  setMessages((old) => ({ ...old, [id]: text }))
                }
                onSuggest={(text) => submit("suggest", text)}
              />
              <div className="studio-columns">
                <section
                  className="studio-card studio-basics"
                  aria-labelledby="studio-basic-title"
                >
                  <header className="studio-card-title">
                    <ControlIcon name="file" size={19} />
                    <h2 id="studio-basic-title">基本信息</h2>
                  </header>
                  <fieldset
                    className="assembly-editable"
                    disabled={actionsLocked}
                  >
                    <div className="assembly-grid">
                      {fields.map(([key, label, placeholder]) => (
                        <label className="assembly-field" key={key}>
                          {label}
                          <input
                            value={edit.config[key]}
                            placeholder={placeholder}
                            onChange={(e) => config(key, e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="assembly-field">
                      智能体职责
                      <textarea
                        value={edit.config.description}
                        rows={2}
                        onChange={(e) => config("description", e.target.value)}
                      />
                    </label>
                    <label className="assembly-field">
                      业务流程与交付物
                      <textarea
                        value={edit.config.workflow}
                        rows={3}
                        onChange={(e) => config("workflow", e.target.value)}
                      />
                    </label>
                    <label className="assembly-field">
                      验收条件（每行一项）
                      <textarea
                        value={edit.config.criteria.join("\n")}
                        rows={2}
                        onChange={(e) =>
                          config("criteria", e.target.value.split("\n"))
                        }
                      />
                    </label>
                  </fieldset>
                </section>
                <section
                  className="studio-card studio-resources"
                  aria-labelledby="studio-resource-title"
                >
                  <header className="studio-card-title">
                    <ControlIcon name="sliders" size={19} />
                    <h2 id="studio-resource-title">资源与权限</h2>
                    <span className="studio-count">
                      已选 {resourceCount} 项
                    </span>
                  </header>
                  <ReadNotice read={options} />
                  {options.data && (
                    <ResourceChoices
                      collapsible
                      options={options.data}
                      selection={edit.config}
                      suggestions={detail.data?.suggestions}
                      onEdit={config}
                      disabled={actionsLocked}
                    />
                  )}
                </section>
              </div>
              <div className="studio-build-footer">
                <div className="studio-build-state">
                  {generating
                    ? "正在生成智能体…"
                    : latest
                      ? editChanged
                        ? "当前修改尚未生成"
                        : "最近生成于 " + when(latest.createdAt)
                      : id
                        ? "此版本尚未生成"
                        : "首次生成时将保存此版本"}
                </div>
                <div className="studio-actions">
                  <button
                    type="button"
                    className="ui-action"
                    disabled={
                      !writable ||
                      !hasDescription ||
                      conflict ||
                      Boolean(id && !buffer)
                    }
                    onClick={() =>
                      void action.run(async () => {
                        try {
                          await save();
                          return "修改已保存。";
                        } finally {
                          setTick((n) => n + 1);
                        }
                      })
                    }
                  >
                    保存修改
                  </button>
                  <button
                    type="button"
                    className="ui-action ui-primary"
                    disabled={!canGenerate}
                    onClick={() => submit("generate")}
                  >
                    <ControlIcon name="layers" /> 生成智能体
                  </button>
                  {latest && !generating && (
                    <button
                      type="button"
                      className="ui-action ui-quiet"
                      onClick={() => {
                        setSelectedBuild(latest.id);
                        navigate("test");
                      }}
                    >
                      {editChanged ? "测试上次生成" : "去测试此版本"} →
                    </button>
                  )}
                </div>
              </div>
              {operations.length > 0 && (
                <details
                  key={id}
                  className="studio-card studio-operations"
                  open={historyOpen || waiting}
                  onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
                >
                  <summary>
                    生成与助手记录
                    <span>
                      {operations.length} 条{waiting ? " · 进行中" : ""}
                    </span>
                  </summary>
                  {[...operations]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((op) => (
                      <div className="studio-operation" key={op.id}>
                        <div>
                          <strong>
                            {op.kind === "suggest"
                              ? "整理工作委托"
                              : "生成智能体"}
                          </strong>
                          <Badge value={op.state} />
                          <time>{when(op.updatedAt || op.createdAt)}</time>
                          {op.message && <p>{factoryMessage(op.message)}</p>}
                        </div>
                        {pendingOperation(op) && (
                          <button
                            className="ui-action ui-small"
                            disabled={!writable}
                            onClick={() =>
                              void action.run(async () => {
                                await factoryApi.post(
                                  `${draftPath(id)}/operations/${encodeURIComponent(op.id)}/stop`,
                                  {},
                                );
                                changed();
                                return "已请求停止操作。";
                              })
                            }
                          >
                            停止操作
                          </button>
                        )}
                      </div>
                    ))}
                </details>
              )}
            </>
          )}
        </section>
        <section {...panelProps("test")}>
          {!visited.test || (id && !detail.data) ? null : latest &&
            detail.data ? (
            <div className="studio-card studio-testing">
              {generating && (
                <p className="live-notice">
                  新记录正在生成，当前样例仍使用下方选定的生成记录。
                </p>
              )}
              <AssemblyTrials
                key={id}
                draft={detail.data}
                selectedBuild={selectedBuild}
                onBuildChange={setSelectedBuild}
                onManageVersion={(id, version) => {
                  setVersion({ id, version });
                  navigate("manage");
                }}
                dirty={Boolean(buffer)}
                disabled={!writable}
                onChange={changed}
                onTask={onTask}
                onNewTask={onNewTask}
              />
            </div>
          ) : (
            <div className="studio-card studio-no-tests">
              <ControlIcon name="terminal" size={26} />
              <h2>
                {!id
                  ? "选择要测试的智能体"
                  : generating
                    ? "智能体正在生成"
                    : "此版本尚未生成"}
              </h2>
              <p>
                {!id
                  ? "在上方选择智能体与版本，查看生成记录和测试结果。"
                  : generating
                    ? "生成完成后，可在这里提交样例。"
                    : "先在组装页生成智能体，再使用样例验证交付结果。"}
              </p>
              <button
                type="button"
                className="ui-action"
                onClick={() => navigate("assemble")}
              >
                返回组装
              </button>
            </div>
          )}
        </section>
        <section {...panelProps("manage")}>
          {visited.manage && !version && versions.length > 0 && (
            <details className="studio-card studio-saved">
              <summary>
                已保存的组装<span>{versions.length} 个版本</span>
              </summary>
              <label className="assembly-field">
                选择编辑记录
                <select
                  value={id}
                  onChange={(e) => select(e.target.value)}
                  disabled={action.busy}
                >
                  <option value="">选择智能体与版本</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              {id && <ReadNotice read={detail} />}
              <div className="studio-actions">
                <button
                  type="button"
                  className="ui-action"
                  disabled={!id || !detail.data}
                  onClick={() => navigate("assemble")}
                >
                  继续组装
                </button>
                {id && !archived && !confirmDelete && (
                  <button
                    type="button"
                    className="ui-action ui-quiet ui-danger"
                    disabled={!writable || waiting}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <ControlIcon name="trash" size={14} /> 删除编辑记录
                  </button>
                )}
                {confirmDelete && (
                  <section className="live-confirm">
                    <p>
                      删除「
                      {current.config.displayName || current.description}
                      」的编辑记录？已生成的版本、测试和发布记录仍可查看。
                    </p>
                    <div className="fc-actions">
                      <button
                        className="ui-action ui-danger ui-small"
                        disabled={!writable}
                        onClick={() =>
                          void action.run(async () => {
                            await factoryApi.post(`${draftPath(id)}/delete`, {
                              revision: current.revision,
                            });
                            setEdits((old) => {
                              const next = { ...old };
                              delete next[id];
                              return next;
                            });
                            select("");
                            changed();
                            return "编辑记录已删除。";
                          })
                        }
                      >
                        确认删除编辑记录
                      </button>
                      <button
                        className="ui-action ui-small"
                        onClick={() => setConfirmDelete(false)}
                      >
                        取消
                      </button>
                    </div>
                  </section>
                )}
              </div>
            </details>
          )}
          {visited.manage && (
            <div className="studio-card studio-manager">
              {version ? (
                <>
                  <button
                    className="ui-action ui-quiet ui-small studio-back"
                    onClick={() => setVersion(null)}
                  >
                    ← 返回版本列表
                  </button>
                  <AgentDetail
                    key={JSON.stringify([version.id, version.version])}
                    {...version}
                    revision={revision + listTick}
                    stale={stale}
                    onChange={changed}
                    onTask={onTask}
                    onTest={
                      action.busy
                        ? undefined
                        : (record) => {
                            select(record.draftId);
                            setSelectedBuild(record.candidateId);
                            navigate("test");
                          }
                    }
                    onBased={
                      action.busy
                        ? undefined
                        : async (agent) => {
                            select(await createDraftFromVersion(agent));
                            navigate("assemble");
                            changed();
                          }
                    }
                  />
                </>
              ) : (
                <div className="studio-catalog">
                  <div className="studio-manager-actions">
                    <button
                      type="button"
                      className="ui-action ui-primary"
                      disabled={action.busy}
                      onClick={() => {
                        select("");
                        navigate("assemble");
                      }}
                    >
                      <ControlIcon name="plus" /> 组装新智能体
                    </button>
                  </div>
                  <AgentCatalog
                    initialFilter=""
                    revision={revision + listTick}
                    onAgent={(id, version) => setVersion({ id, version })}
                  />
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      {library && active && (
        <AssemblyResources
          disabled={stale}
          onClose={() => setLibrary(false)}
          onChange={changed}
        />
      )}
    </section>
  );
}
