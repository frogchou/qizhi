import { useState } from "react";
import { ControlIcon } from "../../components/ControlIcon";
import { ActionNotice, Facts, ReadNotice, useAction } from "./FactoryControls";
import { runtimeName } from "./factory-help";
import { factoryApi } from "./factory-client";
import { useFactoryRead } from "./factory-feed";
import type { UpgradeEntry } from "./assembly-model";

export type PackageTarget = Extract<UpgradeEntry, { kind: "package" }>;
type Capability = { name: string; description: string; effect?: string };
type PackageDefinition = {
  kind: "package" | "writing";
  agentId: string;
  version: string;
  nextVersion: string;
  displayName: string;
  runtime: string;
  capabilities: Capability[];
  resources: {
    skills?: string[];
    mcpTools?: string[];
    connections?: string[];
    preferredCapabilities?: string[];
  };
  inputFields: string[];
  outputFields: string[];
  instructions?: string;
  availablePackages: {
    packageName: string;
    version: string;
    displayName: string;
  }[];
};
type Props = {
  target: PackageTarget;
  offline: boolean;
  onPublished: (agentId: string, version: string) => void;
};
export function PackageUpgrade({ target, offline, onPublished }: Props) {
  const source = useFactoryRead<PackageDefinition>(
    `/v1/factory/agents/${encodeURIComponent(target.agentId)}/versions/${encodeURIComponent(target.version)}/upgrade`,
    0,
  );
  const record = source.data;
  const matches =
    record &&
    record.agentId === target.agentId &&
    record.version === target.version;
  return (
    <>
      <ReadNotice read={source} />
      {record && !matches && (
        <p role="alert" className="live-notice error">
          返回的程序包与所选版本不一致，请重新打开版本详情。
        </p>
      )}
      {matches && (
        <PackageForm
          record={record}
          disabled={offline || !!source.error}
          onPublished={onPublished}
        />
      )}
    </>
  );
}

function PackageForm({
  record,
  disabled,
  onPublished,
}: {
  record: PackageDefinition;
  disabled: boolean;
  onPublished: Props["onPublished"];
}) {
  const [version, setVersion] = useState(record.nextVersion);
  const [displayName, setDisplayName] = useState(record.displayName);
  const [instructions, setInstructions] = useState(record.instructions ?? "");
  const [descriptions, setDescriptions] = useState(() =>
    Object.fromEntries(
      record.capabilities.map((c) => [c.name, c.description ?? ""]),
    ),
  );
  const [packageName, setPackageName] = useState("");
  const action = useAction();
  const locked = disabled || action.busy;
  const staged = record.availablePackages.find(
    (p) => p.packageName === packageName,
  );
  const resources = record.resources;
  async function publish() {
    const targetVersion = staged?.version ?? version.trim();
    const body = staged
      ? {
          intent: "upgrade",
          agentId: record.agentId,
          packageName: staged.packageName,
        }
      : {
          intent: "upgrade",
          agentId: record.agentId,
          baseVersion: record.version,
          version: targetVersion,
          displayName: displayName.trim(),
          capabilities: record.capabilities.map((c) => ({
            name: c.name,
            description: descriptions[c.name].trim(),
          })),
          ...(record.kind === "writing"
            ? { instructions: instructions.trim() }
            : {}),
        };
    const result = await factoryApi.post<{
      agentId: string;
      version: string;
      status: string;
    }>("/v1/factory/releases", body);
    if (
      result?.agentId !== record.agentId ||
      result.version !== targetVersion ||
      !result.status
    )
      throw Error("尚未确认目标版本已登记，请在管理页核对后重试。");
    onPublished(result.agentId, result.version);
  }
  return (
    <form
      className="studio-package"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked) void action.run(publish);
      }}
    >
      <div className="studio-upgrade-origin">
        <ControlIcon name="layers" size={17} />
        <span>
          升级来源{" "}
          <strong>
            {record.displayName} · v{record.version}
          </strong>
        </span>
      </div>
      {record.availablePackages.length > 0 && (
        <label className="assembly-field studio-card">
          版本程序
          <select
            value={packageName}
            onChange={(e) => setPackageName(e.target.value)}
            disabled={locked}
          >
            <option value="">沿用此版本程序</option>
            {record.availablePackages.map((p) => (
              <option key={p.packageName} value={p.packageName}>
                {p.displayName} · v{p.version} · 已部署新版程序
              </option>
            ))}
          </select>
        </label>
      )}
      {staged ? (
        <section className="studio-card">
          <h2>已部署的新版程序</h2>
          <Facts
            rows={[
              ["名称", staged.displayName],
              ["目标版本", staged.version],
              ["程序包", staged.packageName],
            ]}
          />
          <p className="live-subtle">
            本次发布使用该程序包自带的能力声明与实现。
          </p>
        </section>
      ) : (
        <div className="studio-columns">
          <section className="studio-card">
            <header className="studio-card-title">
              <ControlIcon name="file" size={18} />
              <h2>版本内容</h2>
            </header>
            <fieldset className="assembly-editable" disabled={locked}>
              <div className="assembly-grid">
                <label className="assembly-field">
                  智能体名称
                  <input
                    required
                    maxLength={record.kind === "writing" ? 100 : 200}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label className="assembly-field">
                  目标发布版本
                  <input
                    required
                    maxLength={160}
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder={record.nextVersion}
                  />
                </label>
              </div>
              {record.capabilities.map((c) => (
                <label key={c.name} className="assembly-field">
                  {c.name} 能力说明
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={descriptions[c.name]}
                    onChange={(e) =>
                      setDescriptions({
                        ...descriptions,
                        [c.name]: e.target.value,
                      })
                    }
                  />
                </label>
              ))}
              {record.kind === "writing" && (
                <label className="assembly-field">
                  业务流程与写作指令
                  <textarea
                    rows={7}
                    required
                    maxLength={8000}
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                </label>
              )}
            </fieldset>
          </section>
          <section className="studio-card studio-package-context">
            <header className="studio-card-title">
              <ControlIcon name="sliders" size={18} />
              <h2>当前程序与权限</h2>
            </header>
            <Facts
              rows={[
                ["智能体标识", record.agentId],
                ["运行环境", runtimeName(record.runtime)],
                ["Skill", resources.skills?.join("、") || "未选用"],
                ["MCP 工具", resources.mcpTools?.join("、") || "未选用"],
                [
                  "业务能力",
                  resources.preferredCapabilities?.join("、") || "未声明",
                ],
                ["服务连接", resources.connections?.join("、") || "未声明"],
              ]}
            />
            <details className="assembly-disclosure">
              <summary>输入与输出字段</summary>
              <Facts
                rows={[
                  [
                    "输入字段",
                    record.inputFields.join("、") || "未声明固定字段",
                  ],
                  [
                    "输出字段",
                    record.outputFields.join("、") || "未声明固定字段",
                  ],
                ]}
              />
            </details>
            <p className="live-subtle">
              {record.kind === "writing"
                ? "新版沿用原有运行环境和资源，使用上方修改后的写作指令。"
                : "新版沿用原程序、接口和资源授权。需要更换执行逻辑时，可选择中台已部署的新版程序包。"}
            </p>
          </section>
        </div>
      )}
      <div className="studio-build-footer">
        <span>发布后进入待审核，管理员批准后运行自检。</span>
        <button
          className="ui-action ui-primary"
          disabled={
            locked ||
            (!staged &&
              (!version.trim() ||
                !displayName.trim() ||
                (record.kind === "writing" && !instructions.trim())))
          }
          type="submit"
        >
          发布新版本
        </button>
      </div>
      <ActionNotice action={action} />
    </form>
  );
}
