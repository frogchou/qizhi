import { useEffect, useState } from "react";

import type { MaskedServiceConfig } from "../../lib/contracts";
import type { EverythingStatus, QizhiCommands } from "../../lib/tauri";

type SettingsPageProps = { commands: QizhiCommands };

export function SettingsPage({ commands }: SettingsPageProps) {
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState<MaskedServiceConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [everything, setEverything] = useState<EverythingStatus | null>(null);
  const [roots, setRoots] = useState("");
  const [esCliPath, setEsCliPath] = useState("");

  useEffect(() => {
    commands
      .getEverythingStatus?.()
      .then(setEverything)
      .catch(() => {
        setEverything({
          available: false,
          adapter: "unavailable",
          remediation: "Everything 状态暂不可用，请稍后重新检测。",
        });
      });
  }, [commands]);

  useEffect(() => {
    commands
      .getSettings()
      .then((configs) => {
        const openai = configs.find((config) => config.service === "openai");
        if (openai) {
          setEndpoint(openai.endpoint);
          setSaved(openai);
        }
      })
      .catch(() => undefined);
  }, [commands]);

  useEffect(() => {
    commands
      .listScanRules()
      .then((rules) => {
        setRoots(rules.allowedRoots.join("\n"));
        setEsCliPath(rules.esCliPath ?? "");
      })
      .catch(() => undefined);
  }, [commands]);

  async function saveScanRules() {
    setError(null);
    try {
      await commands.saveScanRules({
        allowedRoots: roots
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        customExclusions: [],
        esCliPath: esCliPath.trim() || null,
      });
      setEverything((await commands.getEverythingStatus?.()) ?? null);
    } catch {
      setError("扫描范围未保存，请检查目录与 es.exe 路径。");
    }
  }

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
        <h2>扫描与隐私</h2>
        <p>
          仅扫描你明确添加的工作目录；系统目录、Program
          Files、AppData、回收站、网络路径和重解析点始终被排除。
        </p>
        <p>自定义排除规则将在保存后应用于下一次扫描。</p>
        <label>
          允许扫描的工作目录（每行一个）
          <textarea
            value={roots}
            onChange={(event) => setRoots(event.currentTarget.value)}
          />
        </label>
        <label>
          es.exe 路径
          <input
            value={esCliPath}
            onChange={(event) => setEsCliPath(event.currentTarget.value)}
          />
        </label>
        <button type="button" onClick={saveScanRules}>
          保存扫描范围
        </button>
      </aside>
      <aside aria-label="Everything 状态">
        <h2>Everything</h2>
        <p>
          {everything ? everything.remediation : "正在检测本机 Everything…"}
        </p>
      </aside>
      <aside>
        <h2>连接服务</h2>
        <p>Everything、JEV、RAGFlow 与 Codex 的业务能力将在后续阶段启用。</p>
      </aside>
    </section>
  );
}
