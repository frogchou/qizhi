import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ControlIcon } from "../../components/ControlIcon";
import { FeedbackNotice } from "../../components/FeedbackNotice";
import { factoryApi } from "./factory-client";
import { useFactoryRead } from "./factory-feed";
import { Badge, Modal, ReadNotice, useAction } from "./FactoryControls";
import { AgentCatalog, AgentDetail } from "./FactoryAreas";
import { ResourceChoices, RuntimeNativeChoice } from "./AssemblyChoices";
import { AssemblyResources } from "./AssemblyResources";
import { AssemblyNavigation, type StudioTab } from "./AssemblyNavigation";
import { PackageUpgrade, type PackageTarget } from "./PackageUpgrade";
import { AssemblyBrief } from "./AssemblyBrief";
import { AssemblyTrials } from "./AssemblyTrials";
import {
  OptimizationProgress,
  validOptimizationReceipt,
  type OptimizationActions,
} from "./TrialOptimization";
import { useTrialInputs } from "./trial-inputs";
import {
  assemblies,
  prepareAgentUpgrade,
  type UpgradeEntry,
  draftPath,
  emptyConfig,
  generationOptions,
  editableVersionOptions,
  editingVersionLabel,
  runtimeNativeLabel,
  pendingOperation,
  useRequestId,
  type AssemblyConfig,
  type AssemblyDraft,
  type AssemblyOptions,
  type DraftSummary,
  type FocusedOptimization,
  type OptimizationReceipt,
  type OptimizationSource,
  type TaskScope,
} from "./assembly-model";
import { factoryMessage, when, type OpenTask } from "./factory-model";
import "./assembly.css";
import "./assembly-studio.css";

type Edit = { config: AssemblyConfig; base: DraftSummary };
type Reply = {
  text: string;
  delivery?: { requestId: string; revision: number };
};
// Keep unsent fields separate when the user switches between control planes.
const sessionEdits = new Map<
  string,
  { edits: Record<string, Edit>; replies: Record<string, Reply> }
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
function changedFields(config: AssemblyConfig, base: AssemblyConfig) {
  return Object.fromEntries(
    Object.entries(config).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(base[key as keyof AssemblyConfig]),
    ),
  );
}
function mergeManual(edit: Edit, current: DraftSummary): Edit {
  return {
    base: current,
    config: {
      ...current.config,
      ...changedFields(edit.config, edit.base.config),
    },
  };
}
export function AssemblyWorkspace({
  active,
  endpoint,
  revision,
  connection,
  entry,
  onSettings,
  onChange,
  onTask,
  onNewTask,
}: {
  active: boolean;
  endpoint: string;
  revision: number;
  connection: "loading" | "live" | "reconnecting";
  entry?: UpgradeEntry;
  onSettings: () => void;
  onChange: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
}) {
  const stale = connection !== "live";
  const storageKey = "qizhi.factory.assembly." + endpoint;
  const [id, setId] = useState(() =>
      entry?.kind === "assembly" ? entry.draftId : readSelection(storageKey),
    ),
    [edits, setEdits] = useState<Record<string, Edit>>(
      () => sessionEdits.get(endpoint)?.edits ?? {},
    );
  const paneId = useId();
  const studio = useRef<HTMLElement>(null);
  const detailBack = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<StudioTab>("assemble"),
    [visited, setVisited] = useState({ manage: false, test: false }),
    [selectedBuild, setSelectedBuild] = useState<string>(),
    [historyOpen, setHistoryOpen] = useState(false),
    [version, setVersion] = useState<{ id: string; version: string } | null>(
      null,
    ),
    [packageUpgrade, setPackageUpgrade] = useState<PackageTarget | null>(() =>
      entry?.kind === "package" ? entry : null,
    ),
    [library, setLibrary] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [replies, setReplies] = useState<Record<string, Reply>>(
      () => sessionEdits.get(endpoint)?.replies ?? {},
    ),
    [tick, setTick] = useState(0),
    [listTick, refreshList] = useState(0);
  const trialForms = useTrialInputs();
  const [focusedOptimization, setFocusedOptimization] =
    useState<FocusedOptimization | null>(null);
  const [registeredSource, setRegisteredSource] =
    useState<OptimizationSource | null>(null);
  const optimizationRequest = useRequestId();
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
  const useRuntimeNative =
    edit.config.useRuntimeNative ??
    (!id && options.data?.runtimeNative ? true : undefined);
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
    current.description.trim() || edit.config.description.trim(),
  );
  const reply = replies[id];
  useEffect(() => {
    const requestId = reply?.delivery?.requestId;
    if (
      requestId &&
      detail.data?.messages.some((m) => m.requestId === requestId)
    )
      clearDeliveredReply(id, requestId);
  }, [id, reply, detail.data]);
  useLayoutEffect(() => {
    if (tab === "manage" && version && studio.current) {
      studio.current.scrollTop = 0;
      detailBack.current?.focus({ preventScroll: true });
    }
  }, [tab, version]);
  useEffect(() => {
    if (
      Object.keys(edits).length ||
      Object.values(replies).some((item) => item.text)
    )
      sessionEdits.set(endpoint, { edits, replies });
    else sessionEdits.delete(endpoint);
  }, [edits, replies, endpoint]);
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
  function select(next: string) {
    setPackageUpgrade(null);
    if (next === id) return;
    setId(next);
    setSelectedBuild(undefined);
    setHistoryOpen(false);
    setConfirmDelete(false);
  }
  function changed() {
    setTick((n) => n + 1);
    refreshList((n) => n + 1);
    onChange();
  }
  function clearDeliveredReply(draftId: string, requestId: string) {
    setReplies((old) => {
      if (old[draftId]?.delivery?.requestId !== requestId) return old;
      const next = { ...old };
      delete next[draftId];
      return next;
    });
  }
  function config<K extends keyof AssemblyConfig>(
    key: K,
    value: AssemblyConfig[K],
  ) {
    setEdits((old) => {
      const base = old[id]?.base ?? current;
      const next = { ...(old[id]?.config ?? base.config), [key]: value };
      if (!id && key === "useRuntimeNative" && value === true)
        delete next.useRuntimeNative;
      if (JSON.stringify(next) === JSON.stringify(base.config)) {
        if (!old[id]) return old;
        const remaining = { ...old };
        delete remaining[id];
        return remaining;
      }
      return { ...old, [id]: { config: next, base } };
    });
  }
  async function save(firstMessage?: string): Promise<DraftSummary> {
    if (id && !detail.data)
      throw Error("当前编辑内容尚未加载，请重新读取后再保存。");
    if (conflict)
      throw Error("当前版本的编辑内容已在其他地方更新，请先核对修改。");
    if (id && !buffer) return current;
    if (
      !options.data?.runtimeNative &&
      useRuntimeNative !== current.config.useRuntimeNative
    )
      throw Error("请刷新中台的运行时原生能力设置后再保存。");
    const description =
      current.description.trim() ||
      firstMessage ||
      edit.config.description.trim();
    if (!description) throw Error("请描述智能体的工作，或填写智能体职责。");
    const editedConfig = {
      ...edit.config,
      ...(useRuntimeNative !== undefined && { useRuntimeNative }),
      criteria: edit.config.criteria.map((c) => c.trim()).filter(Boolean),
    };
    if (useRuntimeNative !== undefined) delete editedConfig.nativeSkills;
    const savedConfig = id
      ? editedConfig
      : changedFields(editedConfig, fresh.config);
    const result = await factoryApi.post<DraftSummary>(
      id ? `${draftPath(id)}/save` : assemblies,
      {
        description,
        ...(id && { revision: buffer!.base.revision }),
        ...(Object.keys(savedConfig).length > 0 && { config: savedConfig }),
      },
    );
    if (!result?.id || typeof result.revision !== "number")
      throw Error("未确认保存成功，请重新读取当前编辑内容。");
    setEdits((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    if (!id) {
      setReplies((old) => {
        if (!old[""]) return old;
        const next = { ...old, [result.id]: old[""] };
        delete next[""];
        return next;
      });
      select(result.id);
    }
    return result;
  }
  function submit(kind: "suggest" | "generate") {
    const text = kind === "suggest" ? reply?.text.trim() : undefined;
    if (kind === "suggest" && !text) return;
    void action.run(async () => {
      try {
        const saved = await save(text);
        const body = {
          revision: saved.revision,
          ...(text ? { message: text, generateWhenReady: true } : {}),
        };
        const requestId = text
          ? reply?.delivery?.revision === saved.revision
            ? reply.delivery.requestId
            : crypto.randomUUID()
          : request.forPayload([saved.id, kind, body]);
        if (text && reply)
          setReplies((old) => ({
            ...old,
            [saved.id]: {
              ...reply,
              delivery: { requestId, revision: saved.revision },
            },
          }));
        const receipt = await factoryApi.post<{ id: string }>(
          `${draftPath(saved.id)}/${kind}`,
          { ...body, requestId },
        );
        if (!receipt?.id)
          throw Error(
            kind === "generate"
              ? "尚未确认生成请求，请核对生成记录和可测试版本。"
              : "尚未确认助手已收到消息，请核对助手记录。",
          );
        if (text) clearDeliveredReply(saved.id, requestId);
        else request.confirmed();
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
  const focus =
    focusedOptimization?.draftId === id ? focusedOptimization : null;
  const optimizationOp = focus
    ? operations.find((op) => op.id === focus.operationId)
    : [...operations]
        .filter((op) => op.optimizationSource)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const tracked =
    focus ??
    (optimizationOp?.optimizationSource
      ? {
          draftId: id,
          operationId: optimizationOp.id,
          source: optimizationOp.optimizationSource,
          revision: current.revision,
          state: optimizationOp.state,
        }
      : null);
  const waitingForOptimization = Boolean(
    tracked && pendingOperation(optimizationOp ?? tracked),
  );
  const waiting = waitingForOptimization || operations.some(pendingOperation);
  const resourceCount =
    edit.config.skills.length +
    edit.config.mcpTools.length +
    edit.config.capabilities.length +
    edit.config.datasetIds.length;
  const canSubmit = writable && !conflict && !waiting;
  const canGenerate = canSubmit && hasDescription;
  const loadingDraft = Boolean(id && !detail.data);
  const actionsLocked = action.busy || archived || loadingDraft;
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
  const generating =
    waitingForOptimization ||
    operations.some((op) => op.kind === "generate" && pendingOperation(op));
  const editChanged =
    Boolean(buffer) || (latest && latest.revision !== current.revision);
  function openVersion(agentId: string, targetVersion: string) {
    setVersion({ id: agentId, version: targetVersion });
    navigate("manage");
  }
  function testBuild(candidateId: string) {
    setSelectedBuild(candidateId);
    navigate("test");
  }
  function openSourceTest(source: OptimizationSource) {
    select(source.draftId);
    trialForms
      .forBuild(source.draftId, source.candidateId)
      .update((old) => ({ ...old, selectedRun: source.runId }));
    testBuild(source.candidateId);
  }
  function openOptimization(
    source: OptimizationSource,
    receipt: OptimizationReceipt,
  ) {
    setFocusedOptimization({ ...receipt, source });
    select(receipt.draftId);
    navigate("assemble");
  }
  const optimization: OptimizationActions = {
    focused:
      focus && optimizationOp
        ? { ...focus, state: optimizationOp.state }
        : focusedOptimization,
    registeredSource,
    submitting: action.busy,
    unavailable: stale
      ? "中台连接尚未就绪，请恢复连接并刷新测试记录。"
      : detail.error
        ? "未能读取最新组装内容，请刷新测试记录后重试。"
        : waiting
          ? "当前组装已有操作正在进行，请等待完成后再优化。"
          : undefined,
    open: openOptimization,
    submit(source, revision, feedback, reviewId) {
      void action.run(async () => {
        const body = {
          candidateId: source.candidateId,
          packageDigest: source.packageDigest,
          revision,
          feedback,
          ...(reviewId !== undefined ? { reviewId } : {}),
        };
        const path =
          `${draftPath(source.draftId)}/runs/${encodeURIComponent(source.runId)}/optimize` as const;
        const requestId = optimizationRequest.forPayload(body, path);
        try {
          const receipt = await factoryApi.post<OptimizationReceipt>(path, {
            ...body,
            requestId,
          });
          if (!validOptimizationReceipt(receipt))
            throw Error("尚未收到有效的优化回执，请刷新测试记录后重试。");
          optimizationRequest.confirmed(path);
          openOptimization(source, receipt);
          if (pendingOperation(receipt))
            return "已提交反馈，可在智能体组装查看生成进度。";
        } finally {
          changed();
        }
      });
    },
  };
  const packageOption = packageUpgrade
    ? "package:" + packageUpgrade.agentId + "@" + packageUpgrade.version
    : "";
  return (
    <section
      ref={studio}
      className="fc fc-live assembly-studio"
      aria-label="智能体装配"
      hidden={!active}
    >
      <div
        className="studio-shell"
        data-conversation={tab === "assemble" && !packageUpgrade}
      >
        <header className="studio-header">
          <h1>智能体装配</h1>
          <div className="studio-tools">
            <button
              type="button"
              className="ui-action"
              onClick={() => setLibrary(true)}
            >
              <ControlIcon name="layers" /> 智能体可调用资源管理
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
        <FeedbackNotice
          message={
            active && connection === "reconnecting"
              ? "中台连接已中断。当前编辑会保留，恢复后可提交。"
              : ""
          }
          tone="error"
        />
        {tab !== "manage" && (
          <div className="studio-command">
            <label className="assembly-field studio-draft">
              智能体与版本
              <select
                aria-label="智能体与版本"
                value={packageUpgrade ? packageOption : id}
                disabled={action.busy}
                onChange={(e) => select(e.target.value)}
              >
                {packageUpgrade && (
                  <option value={packageOption}>
                    {packageUpgrade.agentId} · v{packageUpgrade.version} ·
                    程序包升级
                  </option>
                )}
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
                !packageUpgrade &&
                (buffer
                  ? "有未保存修改"
                  : id && detail.data
                    ? "修改已保存"
                    : "")}
            </span>
            {tab === "assemble" && !packageUpgrade && id && !archived && (
              <button
                type="button"
                className="ui-action ui-quiet ui-small studio-archive"
                disabled={!writable || waiting}
                onClick={() => setConfirmDelete(true)}
              >
                删除编辑记录
              </button>
            )}
          </div>
        )}
        <ReadNotice read={list} />
        {id && !packageUpgrade && tab !== "manage" && (
          <ReadNotice read={detail} />
        )}
        <section {...panelProps("assemble")} className="studio-assembly-panel">
          {packageUpgrade ? (
            <PackageUpgrade
              key={packageOption}
              target={packageUpgrade}
              offline={stale}
              onPublished={(agentId, targetVersion) => {
                setPackageUpgrade(null);
                changed();
                openVersion(agentId, targetVersion);
              }}
            />
          ) : (
            <>
              {tracked && (
                <OptimizationProgress
                  focus={tracked}
                  operation={optimizationOp}
                  candidate={detail.data?.candidates.find(
                    (c) => c.id === tracked.operationId,
                  )}
                  onTest={testBuild}
                  onOriginal={() => openSourceTest(tracked.source)}
                />
              )}
              {detail.data?.baseRelease && (
                <div className="studio-upgrade-origin">
                  <ControlIcon name="layers" size={17} />
                  <span>
                    升级来源{" "}
                    <strong>
                      {detail.data.baseRelease.agentId} · v
                      {detail.data.baseRelease.version}
                    </strong>
                  </span>
                </div>
              )}
              {archived && (
                <p className="live-subtle">
                  此编辑记录已删除，仍可查看已生成的版本和测试记录。
                </p>
              )}
              {conflict && detail.data && buffer && (
                <section className="live-confirm" aria-label="编辑冲突">
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
              <div className="studio-assembly-layout">
                <AssemblyBrief
                  key={id}
                  active={active && tab === "assemble"}
                  initialBrief={current.description}
                  reply={reply?.text ?? ""}
                  messages={detail.data?.messages ?? []}
                  candidates={detail.data?.candidates ?? []}
                  canSubmit={canSubmit}
                  pending={
                    generating
                      ? "正在生成智能体…"
                      : waiting
                        ? "装配助手正在回复…"
                        : undefined
                  }
                  locked={actionsLocked}
                  readStatus={
                    loadingDraft
                      ? detail.error
                        ? "暂时无法读取这份装配对话。"
                        : "正在读取装配对话…"
                      : undefined
                  }
                  onReply={(text) =>
                    setReplies((old) => ({ ...old, [id]: { text } }))
                  }
                  onSubmit={() => submit("suggest")}
                  onTest={testBuild}
                />
                <div className="studio-configuration" key={id + "-config"}>
                  <section
                    className="studio-card studio-basics"
                    aria-labelledby="studio-basic-title"
                  >
                    <header className="studio-card-title">
                      <ControlIcon name="file" size={19} />
                      <h2 id="studio-basic-title">智能体基本信息</h2>
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
                              readOnly={
                                key === "agentId" && !!detail.data?.baseRelease
                              }
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
                          onChange={(e) =>
                            config("description", e.target.value)
                          }
                        />
                      </label>
                      <label className="assembly-field">
                        业务流程与交付物
                        <textarea
                          value={edit.config.workflow}
                          rows={2}
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
                        企业资源已选 {resourceCount} 项
                      </span>
                    </header>
                    <ReadNotice read={options} />
                    {options.data && (
                      <>
                        <RuntimeNativeChoice
                          value={useRuntimeNative}
                          status={options.data.runtimeNative}
                          legacy={
                            detail.data && useRuntimeNative === undefined
                              ? runtimeNativeLabel(
                                  edit.config,
                                  options.data.nativeSkills,
                                )
                              : undefined
                          }
                          disabled={actionsLocked}
                          onChange={(enabled) =>
                            config("useRuntimeNative", enabled)
                          }
                        />
                        <ResourceChoices
                          collapsible
                          options={options.data}
                          selection={edit.config}
                          suggestions={detail.data?.suggestions}
                          onEdit={config}
                          disabled={actionsLocked}
                        />
                      </>
                    )}
                  </section>
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
                              changed();
                            }
                          })
                        }
                      >
                        保存修改
                      </button>
                      <button
                        type="button"
                        className="ui-action"
                        disabled={!canGenerate}
                        onClick={() => submit("generate")}
                      >
                        <ControlIcon name="layers" /> 生成智能体
                      </button>
                      {latest && !generating && (
                        <button
                          type="button"
                          className="ui-action ui-quiet"
                          onClick={() => testBuild(latest.id)}
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
                      onToggle={(event) =>
                        setHistoryOpen(event.currentTarget.open)
                      }
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
                                  ? "装配助手"
                                  : "生成智能体"}
                              </strong>
                              <Badge value={op.state} />
                              <time>{when(op.updatedAt || op.createdAt)}</time>
                              {op.message && (
                                <p>{factoryMessage(op.message)}</p>
                              )}
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
                </div>
              </div>
            </>
          )}
        </section>
        <section {...panelProps("test")}>
          {packageUpgrade ? (
            <div className="studio-card studio-no-tests">
              <h2>程序包版本自检</h2>
              <p>新版本提交发布并获得批准后，可在版本详情查看中台自检状态。</p>
              <button
                className="ui-action"
                onClick={() => navigate("assemble")}
              >
                返回组装
              </button>
            </div>
          ) : !visited.test || (id && !detail.data) ? null : latest &&
            detail.data ? (
            <div className="studio-card studio-testing">
              {generating && (
                <p className="live-subtle">
                  新记录正在生成，当前样例仍使用下方选定的生成记录。
                </p>
              )}
              <AssemblyTrials
                key={id}
                draft={detail.data}
                nativeOptions={options.data?.nativeSkills}
                revision={revision + tick}
                forms={trialForms}
                optimization={optimization}
                selectedBuild={selectedBuild}
                onBuildChange={setSelectedBuild}
                onEditDraft={() => navigate("assemble")}
                onManageVersion={(id, version) => {
                  setVersion({ id, version });
                  navigate("manage");
                }}
                dirty={Boolean(buffer)}
                disabled={!writable}
                unavailableReason={
                  archived
                    ? "这份组装记录已归档，原测试和发布记录可供查阅。"
                    : stale
                      ? "中台连接尚未就绪，请恢复连接并刷新测试记录。"
                      : action.busy
                        ? "草稿变更正在提交，请稍后再试。"
                        : "未能读取最新草稿，请刷新测试记录后重试。"
                }
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
          {visited.manage && (
            <div className="studio-card studio-manager">
              {version && (
                <>
                  <button
                    className="ui-action ui-quiet ui-small studio-back"
                    ref={detailBack}
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
                            setRegisteredSource(record);
                            openSourceTest(record);
                          }
                    }
                    onBased={
                      action.busy
                        ? undefined
                        : async (agent) => {
                            const next = await prepareAgentUpgrade(agent);
                            if (next.kind === "package")
                              setPackageUpgrade(next);
                            else {
                              select(next.draftId);
                              changed();
                            }
                            navigate("assemble");
                          }
                    }
                  />
                </>
              )}
              <div className="studio-catalog" hidden={!!version}>
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
                  active={active && tab === "manage" && !version}
                  revision={revision + listTick}
                  onAgent={(id, version) => setVersion({ id, version })}
                />
              </div>
            </div>
          )}
        </section>
      </div>
      {confirmDelete &&
        tab === "assemble" &&
        active &&
        id &&
        !packageUpgrade && (
          <Modal
            title="删除编辑记录"
            onClose={() => setConfirmDelete(false)}
            closeDisabled={action.busy}
          >
            <p>
              删除「{current.config.displayName || current.description}
              」的编辑记录？已生成的版本、测试和发布记录仍可查看。
            </p>
            <div className="fc-actions">
              <button
                className="ui-action ui-danger"
                disabled={!writable || waiting}
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
                className="ui-action"
                disabled={action.busy}
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
            </div>
          </Modal>
        )}
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
