import { FeedbackNotice, useFeedback } from "../../components/FeedbackNotice";
import { useEffect, useMemo, useState } from "react";

import { ControlIcon } from "../../components/ControlIcon";
import type { ModelProviderConfig, QizhiCommands } from "../../lib/tauri";

type Props = { commands: QizhiCommands };

const KEY_OPTIONAL = new Set(["ollama"]);

export function ModelProviderSettingsSection({ commands }: Props) {
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState("openai");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [supportsResponses, setSupportsResponses] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const notify = useFeedback("success");
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
        setLoadError(null);
        setProviders(items);
        setSelectedId(
          items.find((provider) => provider.isActive)?.providerId ??
            items[0].providerId,
        );
      })
      .catch(() => {
        if (mounted) setLoadError("无法读取模型服务商配置。");
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
    try {
      const result = await commands.testModelProvider(input());
      notify(result.message, result.available ? "success" : "error");
    } catch {
      notify("连接测试失败，请检查配置。", "error");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!commands.saveModelProvider || !valid()) return;
    setBusy("save");
    try {
      const saved = await commands.saveModelProvider(input());
      setProviders((current) =>
        current.map((provider) =>
          provider.providerId === saved.providerId ? saved : provider,
        ),
      );
      setApiKey("");
      setLoadError(null);
      notify(`${saved.displayName} 配置已保存。`);
    } catch (error) {
      setApiKey("");
      notify(
        error === "keychain_unavailable"
          ? "无法访问登录钥匙串，请解锁后重试。"
          : "模型服务配置未保存，请检查 Base URL、模型和 API Key。",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    if (!commands.activateModelProvider) return;
    setBusy("activate");
    try {
      const activated = await commands.activateModelProvider(selectedId);
      setProviders((current) =>
        current.map((provider) => ({
          ...provider,
          isActive: provider.providerId === activated.providerId,
        })),
      );
      notify(`已启用 ${activated.displayName} · ${activated.model}。`);
    } catch {
      notify("无法启用该服务，请先保存完整配置并确认 API Key 可用。", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="service-card model-provider-card">
      <FeedbackNotice message={loadError} tone="error" />
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
      </div>
    </article>
  );
}
