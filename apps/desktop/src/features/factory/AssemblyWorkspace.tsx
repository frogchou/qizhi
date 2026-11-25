import { useEffect, useState } from "react";
import { factoryApi } from "./factory-client";
import { useFactoryRead } from "./factory-feed";
import {
  ActionNotice,
  Badge,
  Modal,
  ReadNotice,
  useAction,
} from "./FactoryControls";
import { AgentCatalog, AgentDetail } from "./FactoryAreas";
import { ReleaseForm } from "./FactoryForms";
import { ResourceChoices } from "./AssemblyChoices";
import { AssemblyResources } from "./AssemblyResources";
import { AssemblyTrials } from "./AssemblyTrials";
import {
  assemblies,
  draftPath,
  emptyConfig,
  pendingOperation,
  useRequestId,
  type AssemblyConfig,
  type AssemblyDraft,
  type AssemblyOptions,
  type DraftSummary,
  type TaskScope,
} from "./assembly-model";
import { when, type Agent, type OpenTask } from "./factory-model";
import "./assembly.css";

type Editable = Pick<DraftSummary, "config" | "description">;
type Edit = Editable & { base: DraftSummary };
// The connection settings page unmounts the factory. Keep unsent fields in this window
// until the user saves them, with a separate buffer for each control plane.
const sessionEdits = new Map<
  string,
  { edits: Record<string, Edit>; messages: Record<string, string> }
>();
type Tab = "work" | "resources" | "trials";
const tabs: [Tab, string][] = [
  ["work", "工作说明"],
  ["resources", "资源与权限"],
  ["trials", "候选与试跑"],
];
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
  ["agentId", "智能体标识", "例如 quote-desk"],
  ["version", "拟发布版本", "1.0.0"],
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
  stale,
  onChange,
  onTask,
  onNewTask,
}: {
  active: boolean;
  endpoint: string;
  revision: number;
  stale: boolean;
  onChange: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
}) {
  const storageKey = "qizhi.factory.assembly." + endpoint;
  const [id, setId] = useState(() => readSelection(storageKey)),
    [edits, setEdits] = useState<Record<string, Edit>>(
      () => sessionEdits.get(endpoint)?.edits ?? {},
    );
  const [tab, setTab] = useState<Tab>("work"),
    [manager, setManager] = useState(false),
    [library, setLibrary] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [messages, setMessages] = useState<Record<string, string>>(
      () => sessionEdits.get(endpoint)?.messages ?? {},
    ),
    [tick, setTick] = useState(0),
    [listTick, refreshList] = useState(0);
  const list = useFactoryRead<{ items: DraftSummary[] }>(
    active ? assemblies : null,
    revision + listTick,
  );
  const detail = useFactoryRead<AssemblyDraft>(
    id ? draftPath(id) : null,
    revision + tick,
  );
  const options = useFactoryRead<AssemblyOptions>(
    active ? `${assemblies}/options` : null,
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
  function select(next: string) {
    setId(next);
    setTab("work");
    setConfirmDelete(false);
    try {
      if (next) localStorage.setItem(storageKey, next);
      else localStorage.removeItem(storageKey);
    } catch {
      /* The server remains the durable draft store. */
    }
  }
  function changed() {
    setTick((n) => n + 1);
    refreshList((n) => n + 1);
    onChange();
  }
  function update(partial: Partial<Editable>) {
    setEdits((old) => ({
      ...old,
      [id]: {
        ...(old[id] ?? {
          base: {
            id: current.id,
            revision: current.revision,
            config: current.config,
            description: current.description,
          },
          config: current.config,
          description: current.description,
        }),
        ...partial,
      },
    }));
  }
  function config<K extends keyof AssemblyConfig>(
    key: K,
    value: AssemblyConfig[K],
  ) {
    update({ config: { ...edit.config, [key]: value } });
  }
  async function save(): Promise<DraftSummary> {
    if (id && !detail.data) throw Error("请先读取当前草稿。");
    if (conflict) throw Error("中台已有新修订，请先核对并合并手工改动。");
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
      throw Error("中台未返回草稿及修订号，请刷新草稿列表核对。");
    setEdits((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    if (!id) select(result.id);
    changed();
    return result;
  }
  function submit(kind: "suggest" | "generate") {
    void action.run(async () => {
      try {
        const saved = await save();
        const body = {
          revision: saved.revision,
          ...(kind === "suggest"
            ? {
                message:
                  message.trim() ||
                  edit.description.trim() ||
                  edit.config.description.trim(),
              }
            : {}),
        };
        const receipt = await factoryApi.post<{ id: string }>(
          `${draftPath(saved.id)}/${kind}`,
          { ...body, requestId: request.forPayload([saved.id, kind, body]) },
        );
        if (!receipt?.id) throw Error("中台未返回操作编号，请刷新草稿核对。");
        request.confirmed();
        if (kind === "suggest") setMessages((old) => ({ ...old, [id]: "" }));
        else setTab("trials");
        return "中台操作 " + receipt.id + " 已提交";
      } finally {
        changed();
      }
    });
  }
  const operations =
    detail.data?.operations.filter((o) => o.kind !== "trial") ?? [];
  const waiting = operations.some(pendingOperation);
  return (
    <section
      className="assembly-workspace"
      aria-label="装配工作区"
      hidden={!active}
    >
      <div className="assembly-toolbar">
        <div>
          <h3>装配智能体</h3>
          <span className="live-subtle">
            {id && detail.data
              ? `中台修订 ${detail.data.revision}`
              : "新工作委托"}
            {buffer ? " · 有未保存修改" : ""}
          </span>
        </div>
        <div className="fc-actions">
          <button
            type="button"
            className="ui-action ui-small"
            onClick={() => setLibrary(true)}
          >
            精选资源管理
          </button>
          <button
            type="button"
            className="ui-action ui-small"
            onClick={() => setManager(true)}
          >
            管理智能体
          </button>
        </div>
      </div>
      <div className="assembly-draft-nav">
        <label className="assembly-field">
          装配草稿
          <select
            value={id}
            disabled={action.busy}
            onChange={(e) => select(e.target.value)}
          >
            <option value="">新建草稿</option>
            {id && !list.data?.items.some((d) => d.id === id) && (
              <option value={id}>{id}</option>
            )}
            {list.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.config.displayName || d.description} · 修订 {d.revision}
              </option>
            ))}
          </select>
        </label>
        {id && (
          <button
            type="button"
            className="ui-action ui-small"
            disabled={action.busy}
            onClick={() => select("")}
          >
            新建草稿
          </button>
        )}
      </div>
      <ReadNotice read={list} />
      {id && <ReadNotice read={detail} />}
      {archived && (
        <p className="live-notice">
          此草稿已删除，封存的候选和试跑记录仍可查看。
        </p>
      )}
      <nav className="live-tabs assembly-tabs" aria-label="装配步骤">
        {tabs.map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={value === tab}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {id && !detail.data ? null : (
        <>
          {tab === "work" && (
            <fieldset
              className="assembly-editable"
              disabled={archived || action.busy}
            >
              <label className="assembly-field">
                工作委托
                <textarea
                  aria-label="工作委托"
                  placeholder="写下希望智能体为谁完成什么工作，以及你会怎样验收。"
                  value={edit.description}
                  disabled={action.busy}
                  onChange={(e) => update({ description: e.target.value })}
                />
              </label>
              <section className="assembly-assistant">
                <h4>装配助手</h4>
                {detail.data?.messages.map((m, i) => (
                  <div key={i} className="assembly-message">
                    <b>{m.role === "user" ? "你" : "中台助手"}</b>
                    <p>{m.content}</p>
                  </div>
                ))}
                <label className="assembly-field">
                  给装配助手的消息
                  <textarea
                    rows={2}
                    placeholder="补充约束、回答追问，或让助手整理工作说明"
                    value={message}
                    onChange={(e) =>
                      setMessages({ ...messages, [id]: e.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ui-action ui-small"
                  disabled={!writable || !hasDescription || conflict || waiting}
                  onClick={() => submit("suggest")}
                >
                  发送给装配助手
                </button>
              </section>
              <details
                className="assembly-disclosure"
                open={Boolean(detail.data?.config.workflow) || undefined}
              >
                <summary>手工编辑工作说明</summary>
                <div className="assembly-grid">
                  {fields.map(([key, label, placeholder]) => (
                    <label className="assembly-field" key={key}>
                      {label}
                      <input
                        value={edit.config[key]}
                        disabled={action.busy}
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
                    disabled={action.busy}
                    onChange={(e) => config("description", e.target.value)}
                  />
                </label>
                <label className="assembly-field">
                  业务流程与交付物
                  <textarea
                    value={edit.config.workflow}
                    disabled={action.busy}
                    onChange={(e) => config("workflow", e.target.value)}
                  />
                </label>
                <label className="assembly-field">
                  验收条件（每行一项）
                  <textarea
                    value={edit.config.criteria.join("\n")}
                    disabled={action.busy}
                    onChange={(e) =>
                      config("criteria", e.target.value.split("\n"))
                    }
                  />
                </label>
              </details>
            </fieldset>
          )}
          {tab === "resources" && (
            <>
              <ReadNotice read={options} />
              {options.data && (
                <ResourceChoices
                  options={options.data}
                  selection={edit.config}
                  suggestions={detail.data?.suggestions}
                  onEdit={config}
                  disabled={archived || action.busy}
                />
              )}
            </>
          )}
          {conflict && detail.data && buffer && (
            <section className="live-confirm" role="alert">
              <p>
                你的更改基于修订 {buffer.base.revision}，中台已有修订{" "}
                {detail.data.revision}。
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
                  采用中台修订
                </button>
              </div>
            </section>
          )}
          {tab !== "trials" && (
            <div className="assembly-actions">
              <button
                type="button"
                className="ui-action ui-primary"
                disabled={
                  !writable ||
                  !hasDescription ||
                  conflict ||
                  Boolean(id && !buffer)
                }
                onClick={() =>
                  void action.run(async () => {
                    try {
                      const saved = await save();
                      return "草稿已保存 · 修订 " + saved.revision;
                    } finally {
                      setTick((n) => n + 1);
                    }
                  })
                }
              >
                保存草稿
              </button>
              {id && (
                <button
                  type="button"
                  className="ui-action ui-quiet ui-small"
                  disabled={!writable || waiting}
                  onClick={() => setConfirmDelete(true)}
                >
                  删除草稿
                </button>
              )}
            </div>
          )}
          <div hidden={tab !== "trials"}>
            <div className="assembly-row">
              <h3>候选快照</h3>
              <button
                className="ui-action ui-primary"
                disabled={!writable || !hasDescription || conflict || waiting}
                onClick={() => submit("generate")}
              >
                生成候选包
              </button>
            </div>
            {detail.data ? (
              <AssemblyTrials
                key={id}
                draft={detail.data}
                dirty={Boolean(buffer)}
                disabled={!writable}
                onChange={changed}
                onTask={onTask}
                onNewTask={onNewTask}
              />
            ) : (
              <p className="live-subtle">填写工作委托后即可生成候选。</p>
            )}
          </div>
          {operations.length > 0 && (
            <section className="assembly-operations">
              <h4>中台操作</h4>
              {[...operations]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((op) => (
                  <div key={op.id}>
                    <strong>
                      {op.kind === "suggest" ? "澄清委托" : "生成候选"}
                    </strong>
                    <Badge value={op.state} />
                    <small>
                      {when(op.updatedAt || op.createdAt)} · {op.id}
                    </small>
                    {op.message && <p>{op.message}</p>}
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
            </section>
          )}
        </>
      )}
      {stale && (
        <p className="live-notice" role="status">
          中台连接已中断。当前编辑会保留，恢复后可提交。
        </p>
      )}
      {confirmDelete && (
        <section className="live-confirm">
          <p>
            删除草稿「{current.config.displayName || current.description}
            」？已封存的试跑和发布记录可继续追溯。
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
                  return "草稿已删除。";
                })
              }
            >
              确认删除草稿
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
      <ActionNotice action={action} />
      {manager && (
        <VersionManager
          revision={revision}
          stale={stale}
          onClose={() => setManager(false)}
          refresh={changed}
          onTask={(...args) => {
            setManager(false);
            onTask(...args);
          }}
          onBased={async (agent) => {
            const next = await factoryApi.post<DraftSummary>(assemblies, {
              description: agent.description?.trim() || agent.displayName,
              baseRelease: { agentId: agent.agentId, version: agent.version },
            });
            if (!next?.id) throw Error("中台未返回派生草稿编号。");
            select(next.id);
            setManager(false);
            changed();
          }}
        />
      )}
      {library && (
        <AssemblyResources
          disabled={stale}
          onClose={() => setLibrary(false)}
          onChange={changed}
        />
      )}
    </section>
  );
}
function VersionManager({
  revision,
  stale,
  onClose,
  refresh,
  onTask,
  onBased,
}: {
  revision: number;
  stale: boolean;
  onClose: () => void;
  refresh: () => void;
  onTask: OpenTask;
  onBased: (agent: Agent) => Promise<void>;
}) {
  const [version, select] = useState<{ id: string; version: string } | null>(
      null,
    ),
    [release, setRelease] = useState<{ agent: Agent | null } | null>(null);
  return (
    <>
      <Modal title="管理智能体" wide onClose={onClose}>
        <div className="assembly-version-manager">
          {version ? (
            <>
              <button
                className="ui-action ui-quiet ui-small"
                onClick={() => select(null)}
              >
                ← 返回上一级
              </button>
              <AgentDetail
                key={version.id + "@" + version.version}
                {...version}
                revision={revision}
                stale={stale}
                onChange={refresh}
                onTask={onTask}
                onRelease={(agent) => setRelease({ agent })}
                onBased={onBased}
              />
            </>
          ) : (
            <AgentCatalog
              revision={revision}
              onAgent={(id, version) => select({ id, version })}
              onRelease={() => setRelease({ agent: null })}
            />
          )}
        </div>
      </Modal>
      {release && (
        <ReleaseForm
          agent={release.agent}
          onClose={() => setRelease(null)}
          onAgent={(id, version) => select({ id, version })}
          refresh={refresh}
          stale={stale}
        />
      )}
    </>
  );
}
