import { useEffect, useState } from "react";

import type { MaskedServiceConfig } from "../../lib/contracts";
import type { EverythingStatus, QizhiCommands } from "../../lib/tauri";

type SettingsPageProps = { commands: QizhiCommands };
type ConnectionState = { available: boolean; message: string } | null;

function PathList({
  paths,
  onRemove,
  empty,
}: {
  paths: string[];
  onRemove: (path: string) => void;
  empty: string;
}) {
  if (!paths.length) return <p className="path-list-empty">{empty}</p>;
  return (
    <ul className="path-list">
      {paths.map((path) => (
        <li key={path}>
          <span title={path}>{path}</span>
          <button
            type="button"
            onClick={() => onRemove(path)}
            aria-label={`移除 ${path}`}
          >
            移除
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SettingsPage({ commands }: SettingsPageProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState<MaskedServiceConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(null);
  const [everything, setEverything] = useState<EverythingStatus | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);

  useEffect(() => {
    commands
      .getEverythingStatus?.()
      .then(setEverything)
      .catch(() => undefined);
    commands
      .getSettings()
      .then((configs) => {
        const openai = configs.find((config) => config.service === "openai");
        if (openai) {
          setBaseUrl(openai.endpoint);
          setSaved(openai);
        }
      })
      .catch(() => undefined);
    commands
      .listScanRules()
      .then((rules) => {
        setRoots(rules.allowedRoots);
        setExclusions(rules.customExclusions);
      })
      .catch(() => undefined);
  }, [commands]);

  async function chooseFolder(target: "roots" | "exclusions") {
    const selected = await commands.pickFolder();
    if (!selected) return;
    const update = target === "roots" ? setRoots : setExclusions;
    update((current) =>
      current.includes(selected) ? current : [...current, selected],
    );
  }

  async function saveScanRules() {
    setError(null);
    try {
      await commands.saveScanRules({
        allowedRoots: roots,
        customExclusions: exclusions,
        esCliPath: null,
      });
      setEverything((await commands.getEverythingStatus?.()) ?? null);
    } catch {
      setError("扫描范围未保存，请检查选择的文件夹。");
    }
  }

  async function saveOpenAi() {
    setError(null);
    try {
      const config = await commands.saveSettings({
        service: "openai",
        endpoint: baseUrl,
        apiKey,
      });
      setSaved(config);
      setApiKey("");
    } catch {
      setError("设置未保存，请检查 Base URL 和本机凭据服务。");
      setApiKey("");
    }
  }

  async function testOpenAi() {
    setConnection(null);
    setConnection(
      await commands.testServiceConnection({
        service: "openai",
        endpoint: baseUrl,
        apiKey,
      }),
    );
  }

  return (
    <section aria-labelledby="settings-title">
      <header className="settings-header">
        <h1 id="settings-title">设置</h1>
        <p>本地扫描、隐私范围与服务连接都由你掌控。</p>
      </header>

      <section
        className="settings-block privacy-block"
        aria-labelledby="privacy-title"
      >
        <div>
          <h2 id="privacy-title">扫描与隐私</h2>
          <p>
            仅扫描你允许的文件夹；系统目录、AppData、回收站、网络路径与重解析点始终被排除。
          </p>
        </div>
        <div className="path-columns">
          <div className="path-section">
            <div className="path-heading">
              <h3>扫描范围</h3>
              <button
                type="button"
                className="button secondary"
                onClick={() => chooseFolder("roots")}
              >
                添加文件夹
              </button>
            </div>
            <p>
              首次已预填用户目录、桌面、文档、图片和非 C 盘磁盘；可按需移除。
            </p>
            <PathList
              paths={roots}
              empty="尚未选择扫描范围。"
              onRemove={(path) =>
                setRoots((items) => items.filter((item) => item !== path))
              }
            />
          </div>
          <div className="path-section">
            <div className="path-heading">
              <h3>排除目录</h3>
              <button
                type="button"
                className="button secondary"
                onClick={() => chooseFolder("exclusions")}
              >
                添加文件夹
              </button>
            </div>
            <p>排除目录优先于扫描范围；可用来保护私密或无关资料。</p>
            <PathList
              paths={exclusions}
              empty="没有自定义排除目录。"
              onRemove={(path) =>
                setExclusions((items) => items.filter((item) => item !== path))
              }
            />
          </div>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={saveScanRules}
        >
          保存扫描范围
        </button>
      </section>

      <section className="settings-block" aria-labelledby="services-title">
        <div>
          <h2 id="services-title">连接服务</h2>
          <p>凭据保存在 Windows 凭据管理器中，界面只显示掩码。</p>
        </div>
        <article className="service-card">
          <div className="service-name">
            <span className="service-icon">⌕</span>
            <div>
              <h3>Everything</h3>
              <p>
                使用随栖知安装的 SDK 查询本机文件；请保持 Everything
                在后台运行。
              </p>
            </div>
          </div>
          <p
            className={
              everything?.available ? "service-state ready" : "service-state"
            }
          >
            {everything?.available ? "已连接" : "等待连接"}
          </p>
        </article>
        <article className="service-card openai-card">
          <div className="service-name">
            <span className="service-icon">◎</span>
            <div>
              <h3>OpenAI API</h3>
              <p>用于工作总结与内容分析，支持 OpenAI 兼容服务。</p>
            </div>
          </div>
          <div className="service-form">
            <label>
              Base URL
              <input
                aria-label="OpenAI Base URL"
                value={baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => setBaseUrl(event.currentTarget.value)}
              />
            </label>
            <label>
              API Key
              <input
                aria-label="OpenAI API Key"
                type="password"
                value={apiKey}
                placeholder={saved ? saved.apiKeyMask : "填写后可测试"}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
            </label>
            <div className="service-actions">
              <button
                type="button"
                className="button outline"
                onClick={testOpenAi}
                disabled={!baseUrl || !apiKey}
              >
                测试连接
              </button>
              <button
                type="button"
                className="button primary"
                onClick={saveOpenAi}
                disabled={!baseUrl || !apiKey}
              >
                保存
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
          </div>
        </article>
        <article className="service-card muted-service">
          <div className="service-name">
            <span className="service-icon">T</span>
            <div>
              <h3>TypeSafe AI / JEV</h3>
              <p>价值判断与敏感信息识别将在下一阶段启用。</p>
            </div>
          </div>
        </article>
        <article className="service-card muted-service">
          <div className="service-name">
            <span className="service-icon">≡</span>
            <div>
              <h3>RAGFlow</h3>
              <p>知识库管理与问答将在下一阶段启用。</p>
            </div>
          </div>
        </article>
        <article className="service-card muted-service">
          <div className="service-name">
            <span className="service-icon">⌘</span>
            <div>
              <h3>Codex</h3>
              <p>本地 CLI 复杂任务将在下一阶段启用。</p>
            </div>
          </div>
        </article>
      </section>
      {error ? (
        <p role="alert" className="settings-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
