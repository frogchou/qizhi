import { useState } from "react";
import { Empty, Modal, ReadNotice, useAction } from "./FactoryControls";
import { factoryApi } from "./factory-client";
import { SkillFileEditor, SkillFileViewer } from "./SkillFiles";
import { markdownLimit, readMarkdown, type SkillFile } from "./skill-files";
import { useFactoryRead } from "./factory-feed";
import {
  resources,
  effectLabel,
  type ResourceDirectory,
  type ResourceKind,
  type ResourceState,
  type ResourceVersion,
} from "./assembly-model";

const states: Record<ResourceState, string> = {
  active: "已启用",
  unlisted: "已下架",
  disabled: "已停用",
};
const emptyResource = {
  kind: "skill" as ResourceKind,
  id: "",
  version: "1.0.0",
  label: "",
  description: "",
  content: "",
  toolId: "",
  simulationToolId: "",
};
export function AssemblyResources({
  onClose,
  onChange,
  disabled,
}: {
  onClose: () => void;
  onChange: () => void;
  disabled: boolean;
}) {
  const read = useFactoryRead<ResourceDirectory>(resources, 0);
  const [entry, setEntry] = useState({ ...emptyResource }),
    [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<ResourceVersion | null>(null);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const localImport = useAction();
  const [confirm, setConfirm] = useState<{
    item: ResourceVersion;
    state: ResourceState;
  } | null>(null);
  const action = useAction(() => {
    read.retry();
    onChange();
  });
  const providers = read.data?.providers ?? [],
    provider = providers.find((p) => p.id === entry.toolId);
  const change = (key: keyof typeof entry, value: string) =>
    setEntry((old) => ({ ...old, [key]: value }));
  const usable = !disabled && !action.busy && !localImport.busy && !read.error;
  const valid =
    entry.id.trim() &&
    entry.label.trim() &&
    entry.description.trim() &&
    entry.version.trim() &&
    (entry.kind === "skill" ? entry.content.trim() : provider);
  function edit(item?: ResourceVersion) {
    setFiles(item?.files ?? []);
    setEntry(
      item
        ? {
            kind: item.kind,
            id: item.id,
            version: "",
            label: item.label,
            description: item.description ?? "",
            content: item.content ?? "",
            toolId: item.toolId ?? "",
            simulationToolId: item.simulationToolId ?? "",
          }
        : { ...emptyResource },
    );
    setConfirm(null);
    setEditing(true);
  }
  function inspect(item: ResourceVersion, forEdit: boolean) {
    void action.run(async () => {
      const full = await factoryApi.get<ResourceVersion>(
        `${resources}/${item.kind}/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}`,
      );
      if (forEdit) edit(full);
      else setPreview(full);
    });
  }
  return (
    <Modal
      title="智能体可调用资源管理"
      onClose={onClose}
      closeDisabled={action.busy || localImport.busy}
      wide
    >
      <ReadNotice read={read} />
      {!editing && (
        <>
          <div className="live-bar">
            <h3>已登记的资源版本</h3>
            <button
              type="button"
              className="ui-action ui-primary"
              disabled={!usable}
              onClick={() => edit()}
            >
              登记资源
            </button>
          </div>
          <div className="assembly-library">
            {read.data?.items.map((item) => (
              <article key={[item.kind, item.id, item.version].join("/")}>
                <div className="assembly-row">
                  <strong>{item.label}</strong>
                  <span>{states[item.state]}</span>
                </div>
                <p>{item.description}</p>
                <small>
                  {item.kind === "skill" ? "Skill" : "MCP"} · {item.id} · v
                  {item.version}
                  {item.effect && " · " + effectLabel(item.effect)}
                  {item.kind === "skill" && item.fileCount
                    ? " · " + item.fileCount + " 个辅助文件"
                    : ""}
                </small>
                <details>
                  <summary>登记详情</summary>
                  {item.digest && (
                    <p>
                      内容摘要 <code>{item.digest}</code>
                    </p>
                  )}
                  {item.runtimes?.length && (
                    <p>适用运行时 {item.runtimes.join("、")}</p>
                  )}
                  {item.toolId && <p>执行工具 {item.toolId}</p>}
                  {item.destination && <p>目的地 {item.destination}</p>}
                  {item.simulationToolId && (
                    <p>模拟工具 {item.simulationToolId}</p>
                  )}
                  {item.inputSchema || item.outputSchema ? (
                    <pre className="assembly-code">
                      {JSON.stringify(
                        { input: item.inputSchema, output: item.outputSchema },
                        null,
                        2,
                      )}
                    </pre>
                  ) : null}
                  {item.usedBy && (
                    <p>
                      使用此版本的智能体 ·{" "}
                      {item.usedBy
                        .map((v) => v.agentId + " v" + v.version)
                        .join("、") || "暂无"}
                    </p>
                  )}
                </details>
                <div className="fc-actions">
                  <button
                    className="ui-action ui-small"
                    disabled={!usable}
                    onClick={() => inspect(item, false)}
                  >
                    查看版本内容
                  </button>
                  <button
                    className="ui-action ui-small"
                    disabled={!usable}
                    onClick={() => inspect(item, true)}
                  >
                    登记新版本
                  </button>
                  {(["active", "unlisted", "disabled"] as const)
                    .filter((next) => next !== item.state)
                    .map((next) => (
                      <button
                        key={next}
                        className="ui-action ui-small"
                        disabled={!usable}
                        onClick={() => setConfirm({ item, state: next })}
                      >
                        {next === "active"
                          ? "启用"
                          : next === "unlisted"
                            ? "下架"
                            : "紧急停用"}
                      </button>
                    ))}
                </div>
              </article>
            ))}
          </div>
          {read.data && !read.data.items.length && (
            <Empty>尚未登记精选资源</Empty>
          )}
          {confirm && (
            <section className="live-confirm">
              <strong>
                {confirm.item.label} · v{confirm.item.version}
              </strong>
              <p>
                {confirm.state === "disabled"
                  ? "停用后，中台会阻止该版本尚未执行的调用。"
                  : confirm.state === "unlisted"
                    ? "下架后，新的装配配置无法选择此版本。"
                    : "启用后，新的装配配置可以选择此版本。"}
              </p>
              <div className="fc-actions">
                <button
                  className="ui-action ui-primary"
                  disabled={!usable}
                  onClick={() =>
                    void action.run(async () => {
                      const i = confirm.item;
                      await factoryApi.post(
                        `${resources}/${i.kind}/${encodeURIComponent(i.id)}/${encodeURIComponent(i.version)}/state`,
                        { state: confirm.state },
                      );
                      setConfirm(null);
                      return "已更新资源状态。";
                    })
                  }
                >
                  确认变更
                </button>
                <button className="ui-action" onClick={() => setConfirm(null)}>
                  取消
                </button>
              </div>
            </section>
          )}
        </>
      )}
      {editing && (
        <form
          className="assembly-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !usable) return;
            void action.run(async () => {
              const {
                kind,
                id,
                version,
                label,
                description,
                content,
                toolId,
                simulationToolId,
              } = entry;
              if (
                kind === "skill" &&
                new TextEncoder().encode(content).length > markdownLimit
              )
                throw Error("中台接受最多 48 KiB 的 Skill 正文。");
              await factoryApi.post(resources, {
                kind,
                id: id.trim(),
                version: version.trim(),
                label: label.trim(),
                description: description.trim(),
                ...(kind === "skill"
                  ? {
                      content,
                      files: files.map(({ path, contentBase64 }) => ({
                        path,
                        contentBase64,
                      })),
                    }
                  : {
                      toolId,
                      effect: provider?.effect,
                      ...(simulationToolId ? { simulationToolId } : {}),
                    }),
              });
              setEditing(false);
              return "已登记资源版本。";
            });
          }}
        >
          <div className="assembly-grid">
            <label className="assembly-field">
              资源类型
              <select
                value={entry.kind}
                disabled={localImport.busy}
                onChange={(e) => {
                  change("kind", e.target.value);
                }}
              >
                <option value="skill">Skill</option>
                <option value="mcp">已安装的 MCP 工具</option>
              </select>
            </label>
            <label className="assembly-field">
              资源名称
              <input
                required
                value={entry.label}
                onChange={(e) => change("label", e.target.value)}
              />
            </label>
            <label className="assembly-field">
              资源标识
              <input
                required
                value={entry.id}
                placeholder="quote-style"
                onChange={(e) => change("id", e.target.value)}
              />
            </label>
            <label className="assembly-field">
              资源版本
              <input
                required
                value={entry.version}
                placeholder="1.0.0"
                onChange={(e) => change("version", e.target.value)}
              />
            </label>
          </div>
          <label className="assembly-field">
            资源用途
            <textarea
              required
              value={entry.description}
              onChange={(e) => change("description", e.target.value)}
            />
          </label>
          {entry.kind === "skill" ? (
            <>
              <label className="assembly-field">
                导入 Skill 正文
                <input
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  disabled={!usable}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.currentTarget.value = "";
                    if (file)
                      void localImport.run(async () => {
                        change("content", await readMarkdown(file));
                      });
                  }}
                />
              </label>
              <label className="assembly-field">
                Skill 正文
                <textarea
                  required
                  value={entry.content}
                  disabled={localImport.busy}
                  onChange={(e) => change("content", e.target.value)}
                />
              </label>
              <SkillFileEditor
                files={files}
                markdown={entry.content}
                onChange={setFiles}
                onMarkdown={(content) => change("content", content)}
                action={localImport}
                disabled={!usable}
              />
            </>
          ) : (
            <>
              <label className="assembly-field">
                已安装的执行工具
                <select
                  required
                  value={entry.toolId}
                  onChange={(e) =>
                    setEntry((old) => ({
                      ...old,
                      toolId: e.target.value,
                      simulationToolId: "",
                    }))
                  }
                >
                  <option value="">请选择中台工具</option>
                  {providers.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={p.available === false}
                    >
                      {p.label} · {p.id}
                      {p.available === false ? " · 不可用" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {provider && (
                <>
                  <p>
                    {provider.description} · {effectLabel(provider.effect)}
                  </p>
                  {provider.inputSchema || provider.outputSchema ? (
                    <details>
                      <summary>参数与返回内容</summary>
                      <pre className="assembly-code">
                        {JSON.stringify(
                          {
                            input: provider.inputSchema,
                            output: provider.outputSchema,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ) : null}
                </>
              )}
              {provider?.effect === "external_write" && (
                <label className="assembly-field">
                  测试用模拟工具
                  <select
                    value={entry.simulationToolId}
                    onChange={(e) => change("simulationToolId", e.target.value)}
                  >
                    <option value="">未登记模拟适配器</option>
                    {providers
                      .filter(
                        (p) =>
                          p.id !== entry.toolId &&
                          p.effect === "simulate" &&
                          p.available !== false,
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} · {p.id}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </>
          )}
          <footer>
            <button
              className="ui-action"
              type="button"
              disabled={action.busy || localImport.busy}
              onClick={() => setEditing(false)}
            >
              返回资源列表
            </button>
            <button
              className="ui-action ui-primary"
              disabled={!usable || !valid}
            >
              保存资源版本
            </button>
          </footer>
        </form>
      )}
      {preview && (
        <Modal title="资源版本内容" onClose={() => setPreview(null)} wide>
          <h3>{preview.label}</h3>
          <p>
            {preview.id} · v{preview.version} · {states[preview.state]}
          </p>
          <pre className="assembly-code">
            {preview.kind === "skill"
              ? preview.content
              : JSON.stringify(
                  {
                    toolId: preview.toolId,
                    destination: preview.destination,
                    effect: preview.effect,
                    simulationToolId: preview.simulationToolId,
                    inputSchema: preview.inputSchema,
                    outputSchema: preview.outputSchema,
                  },
                  null,
                  2,
                )}
          </pre>
          {preview.kind === "skill" && (
            <SkillFileViewer files={preview.files ?? []} />
          )}
        </Modal>
      )}
    </Modal>
  );
}
