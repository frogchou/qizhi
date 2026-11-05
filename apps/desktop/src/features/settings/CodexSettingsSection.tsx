import { useEffect, useState } from "react";

import type {
  CodexModelOption,
  CodexPreferences,
  CodexRuntimeStatus,
  QizhiCommands,
} from "../../lib/tauri";

export function CodexSettingsSection({
  commands,
}: {
  commands: QizhiCommands;
}) {
  const [status, setStatus] = useState<CodexRuntimeStatus | null>(null);
  const [preferences, setPreferences] = useState<CodexPreferences>({
    model: "",
    reasoningEffort: "medium",
  });
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<CodexModelOption[]>([]);

  async function refresh(force = false) {
    if (!commands.getCodexStatus) return;
    try {
      const nextStatus =
        force && commands.refreshCodexStatus
          ? await commands.refreshCodexStatus()
          : await commands.getCodexStatus();
      setStatus(nextStatus);
      if (nextStatus.installation === "ready" && commands.listCodexModels) {
        try {
          setModels(await commands.listCodexModels());
        } catch {
          setModels([]);
        }
      }
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refresh();
    commands
      .getCodexPreferences?.()
      .then(setPreferences)
      .catch(() => undefined);
  }, []);

  async function save() {
    if (!commands.saveCodexPreferences) return;
    try {
      setPreferences(
        await commands.saveCodexPreferences(
          preferences.model,
          preferences.reasoningEffort,
        ),
      );
      setNotice("Codex 默认设置已保存。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }
  const selectedModel = models.find((model) => model.id === preferences.model);
  const efforts = selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : ["low", "medium", "high", "xhigh"];

  return (
    <article className="service-card codex-settings-card">
      <div className="service-name">
        <span className="service-icon">⌘</span>
        <div>
          <h3>Codex</h3>
          <p>复用本机 Codex 的账号、网络、MCP、Skills 和插件。</p>
        </div>
      </div>
      <div className="service-form codex-diagnostics">
        <div className="codex-status-grid">
          <span>
            本机程序
            <strong>
              {status?.installation === "ready" ? "已安装" : "未就绪"}
            </strong>
          </span>
          <span>
            版本<strong>{status?.version ?? "—"}</strong>
          </span>
          <span>
            账号
            <strong>
              {status?.account === "ready"
                ? "已复用登录"
                : "需要在 Codex 中登录"}
            </strong>
          </span>
          <span>
            沙箱
            <strong>
              {status?.sandbox === "ready"
                ? "可用"
                : (status?.sandbox ?? "检测中")}
            </strong>
          </span>
        </div>
        <label>
          默认模型
          <select
            aria-label="Codex 默认模型"
            value={preferences.model}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                model: event.currentTarget.value,
                reasoningEffort:
                  models.find((model) => model.id === event.currentTarget.value)
                    ?.defaultReasoningEffort ?? preferences.reasoningEffort,
              })
            }
          >
            <option value="">跟随 Codex 默认模型</option>
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.displayName}
                {model.isDefault ? "（推荐）" : ""}
              </option>
            ))}
            {preferences.model && !selectedModel ? (
              <option value={preferences.model}>{preferences.model}</option>
            ) : null}
          </select>
        </label>
        <label>
          推理强度
          <select
            aria-label="Codex 推理强度"
            value={preferences.reasoningEffort}
            onChange={(event) =>
              setPreferences({
                ...preferences,
                reasoningEffort: event.currentTarget.value,
              })
            }
          >
            {efforts.map((effort) => (
              <option value={effort} key={effort}>
                {effortLabel(effort)}
              </option>
            ))}
            {!efforts.includes(preferences.reasoningEffort) ? (
              <option value={preferences.reasoningEffort}>
                {effortLabel(preferences.reasoningEffort)}
              </option>
            ) : null}
          </select>
        </label>
        <div className="service-actions">
          <button
            className="button outline"
            type="button"
            onClick={() => void refresh(true)}
          >
            重新检测
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => void save()}
          >
            保存 Codex 设置
          </button>
        </div>
        {notice ? (
          <p className="connection-result" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function effortLabel(value: string) {
  const labels: Record<string, string> = {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
  };
  return labels[value] ?? value;
}
