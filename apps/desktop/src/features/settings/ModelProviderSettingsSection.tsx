import { useEffect, useMemo, useState } from "react";

import { ControlIcon } from "../../components/ControlIcon";
import type {
  ConnectionStatus,
  ModelProviderConfig,
  QizhiCommands,
} from "../../lib/tauri";

type Props = { commands: QizhiCommands };

const KEY_OPTIONAL = new Set(["ollama"]);

export function ModelProviderSettingsSection({ commands }: Props) {
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState("openai");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [supportsResponses, setSupportsResponses] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "activate" | null>(null);

  const selected = useMemo(
    () => providers.find((provider) => provider.providerId === selectedId),
    [providers, selectedId],
  );
  const active = providers.find((provider) => provider.isActive) ?? null;
  const keyRequired = !KEY_OPTIONAL.has(selectedId);

  useEffect(() => {
    let mounted = true;
    commands
      .listModelProviders?.()
      .then((items) => {
        if (!mounted || !items?.length) return;
        setProviders(items);
        setSelectedId(
          items.find((provider) => provider.isActive)?.providerId ??
            items[0].providerId,
        );
      })
      .catch(() => {
        if (mounted) setError("无法读取模型服务商配置。");
      });
    return () => {
      mounted = false;
    };
  }, [commands]);

  useEffect(() => {
    if (!selected) return;
    setEndpoint(selected.endpoint);
    setModel(selected.model);
    setSupportsResponses(selected.supportsResponses);
    setApiKey("");
    setConnection(null);
    setNotice(null);
    setError(null);
  }, [selected]);

  function input() {
    return {
      providerId: selectedId,
      endpoint: endpoint.trim(),
      model: model.trim(),
      apiKey,
      supportsResponses:
        selectedId === "custom" ? supportsResponses : undefined,
    };
  }

  function valid() {
    return Boolean(endpoint.trim() && model.trim());
  }

  async function test() {
    if (!commands.testModelProvider || !valid()) return;
    setBusy("test");
    setConnection(null);
    setError(null);
    try {
      setConnection(await commands.testModelProvider(input()));
    } catch {
      setConnection({
        available: false,
        message: "连接测试失败，请检查配置。",
      });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!commands.saveModelProvider || !valid()) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await commands.saveModelProvider(input());
      setProviders((current) =>
        current.map((provider) =>
          provider.providerId === saved.providerId ? saved : provider,
        ),
      );
      setApiKey("");
      setNotice(`${saved.displayName} 配置已保存。`);
    } catch {
      setApiKey("");
      setError("模型服务配置未保存，请检查 Base URL、模型和 API Key。");
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    if (!commands.activateModelProvider) return;
    setBusy("activate");
    setError(null);
    setNotice(null);
    try {
      const activated = await commands.activateModelProvider(selectedId);
      setProviders((current) =>
        current.map((provider) => ({
          ...provider,
          isActive: provider.providerId === activated.providerId,
        })),
      );
      setNotice(`已启用 ${activated.displayName} · ${activated.model}。`);
    } catch {
      setError("无法启用该服务，请先保存完整配置并确认 API Key 可用。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="service-card model-provider-card">
      <div className="service-name">
        <span className="service-icon" aria-hidden="true">
          <ControlIcon name="connection" size={18} />
        </span>
        <div>
          <h3>模型服务</h3>
          <p>统一用于今日总结与后续 AI 能力，同一时间只启用一个服务。</p>
          <p className="active-provider-summary">
            {active
              ? `当前启用：${active.displayName} · ${active.model}`
              : "当前尚未启用模型服务"}
          </p>
        </div>
      </div>
      <div className="service-form model-provider-form">
        <label>
          服务商
          <select
            aria-label="模型服务商"
            disabled={!providers.length || busy !== null}
            onChange={(event) => setSelectedId(event.currentTarget.value)}
            value={selectedId}
          >
            {providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.displayName}
                {provider.isActive ? "（已启用）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Base URL
          <input
            aria-label="模型 Base URL"
            disabled={busy !== null}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            placeholder="https://api.example.com/v1"
            value={endpoint}
          />
        </label>
        <label>
          模型
          <input
            aria-label="模型名称"
            disabled={busy !== null}
            onChange={(event) => setModel(event.currentTarget.value)}
            placeholder="输入服务商提供的模型名称"
            value={model}
          />
        </label>
        <label>
          API Key
          <input
            aria-label="模型 API Key"
            disabled={busy !== null}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder={
              selected?.apiKeyMask ||
              (keyRequired ? "填写后可测试" : "本地服务可留空")
            }
            required={keyRequired}
            type="password"
            value={apiKey}
          />
        </label>
        {selectedId === "custom" ? (
          <label className="provider-capability-toggle">
            <span>Responses</span>
            <span>
              <input
                checked={supportsResponses}
                onChange={(event) =>
                  setSupportsResponses(event.currentTarget.checked)
                }
                type="checkbox"
              />
              支持 Responses 文件输入
            </span>
          </label>
        ) : null}
        <div className="service-actions model-provider-actions">
          <button
            className="button outline"
            disabled={!valid() || busy !== null}
            onClick={() => void test()}
            type="button"
          >
            {busy === "test" ? "测试中…" : "测试连接"}
          </button>
          <button
            className="button outline"
            disabled={!valid() || busy !== null}
            onClick={() => void save()}
            type="button"
          >
            {busy === "save" ? "保存中…" : "保存配置"}
          </button>
          <button
            className="button primary"
            disabled={selected?.isActive || busy !== null}
            onClick={() => void activate()}
            type="button"
          >
            {selected?.isActive
              ? "当前已启用"
              : busy === "activate"
                ? "启用中…"
                : "启用此服务"}
          </button>
        </div>
        {connection ? (
          <p
            className={
              connection.available
                ? "connection-result ready"
                : "connection-result"
            }
          >
            {connection.message}
          </p>
        ) : null}
        {notice ? <p className="connection-result ready">{notice}</p> : null}
        {error ? <p className="settings-error">{error}</p> : null}
      </div>
    </article>
  );
}
