import { useState } from "react";

import type { MaskedServiceConfig } from "../../lib/contracts";
import type { QizhiCommands } from "../../lib/tauri";

type SettingsPageProps = { commands: QizhiCommands };

export function SettingsPage({ commands }: SettingsPageProps) {
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState<MaskedServiceConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      const config = await commands.saveSettings({
        service: "openai",
        endpoint,
        apiKey,
      });
      setSaved(config);
      setApiKey("");
    } catch {
      setError("设置未保存，请检查地址和本地凭据服务。");
      setApiKey("");
    }
  }

  return (
    <section aria-labelledby="settings-title">
      <h1 id="settings-title">设置</h1>
      <p>连接信息保存在本机凭据库中，界面只显示掩码。</p>
      <label>
        OpenAI API 地址
        <input
          value={endpoint}
          onChange={(event) => setEndpoint(event.currentTarget.value)}
        />
      </label>
      <label>
        OpenAI API Key
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.currentTarget.value)}
        />
      </label>
      <button type="button" onClick={save}>
        保存更改
      </button>
      {saved ? <p aria-label="已保存密钥掩码">{saved.apiKeyMask}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <aside>
        <h2>连接服务</h2>
        <p>Everything、JEV、RAGFlow 与 Codex 的业务能力将在后续阶段启用。</p>
      </aside>
    </section>
  );
}
