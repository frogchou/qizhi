import { useEffect, useState } from "react";

import type { MaskedServiceConfig } from "../../lib/contracts";
import type {
  FileCategory,
  JevValuePolicy,
  QizhiCommands,
} from "../../lib/tauri";
import { SummarySettingsSection } from "./SummarySettingsSection";
import { CodexSettingsSection } from "./CodexSettingsSection";

type SettingsPageProps = { commands: QizhiCommands };
type ConnectionState = { available: boolean; message: string } | null;

const DEFAULT_JEV_POLICY: JevValuePolicy = {
  instructions:
    "根据文件名和实际内容，评估这个文件对计算机办公工作的长期知识价值。重点考虑是否包含可复用的知识、分析、决策、方案、数据、重要代码或正式交付成果；不要仅因篇幅长而给高分。",
  criteria: [
    "几乎没有工作价值：缓存、模板噪声、空内容、自动生成或不可复用的临时文件",
    "较低工作价值：重复内容、短期中间产物，后续很少需要查找或复用",
    "一般工作价值：记录了具体工作信息，对当前任务或个人回顾有帮助",
    "较高工作价值：包含可复用的知识、分析、决策、方案、数据或重要代码",
    "很高工作价值：关键交付物、正式结论、核心设计或值得长期进入知识库的资料",
  ],
  valuableThreshold: 2.5,
};

function displayPath(path: string) {
  return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

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
          <span title={displayPath(path)}>{displayPath(path)}</span>
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
  const [ragflowBaseUrl, setRagflowBaseUrl] = useState("");
  const [ragflowApiKey, setRagflowApiKey] = useState("");
  const [ragflowSaved, setRagflowSaved] = useState<MaskedServiceConfig | null>(
    null,
  );
  const [jevBaseUrl, setJevBaseUrl] = useState("https://api.typesafe.ai");
  const [jevApiKey, setJevApiKey] = useState("");
  const [jevSaved, setJevSaved] = useState<MaskedServiceConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(null);
  const [ragflowConnection, setRagflowConnection] =
    useState<ConnectionState>(null);
  const [jevConnection, setJevConnection] = useState<ConnectionState>(null);
  const [jevInstructions, setJevInstructions] = useState(
    DEFAULT_JEV_POLICY.instructions,
  );
  const [jevCriteria, setJevCriteria] = useState(
    DEFAULT_JEV_POLICY.criteria.join("\n"),
  );
  const [jevThreshold, setJevThreshold] = useState("2.5");
  const [jevPolicyNotice, setJevPolicyNotice] = useState<string | null>(null);
  const [ntfsIndexer, setNtfsIndexer] = useState<ConnectionState>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [scanRulesNotice, setScanRulesNotice] = useState<string | null>(null);
  const [fileCategories, setFileCategories] = useState<FileCategory[]>([
    "documents",
    "sourceCode",
  ]);
  const [directoryGroupThreshold, setDirectoryGroupThreshold] = useState("5");

  useEffect(() => {
    commands
      .getNtfsIndexerStatus?.()
      .then(setNtfsIndexer)
      .catch(() => undefined);
    commands
      .getSettings()
      .then((configs) => {
        const openai = configs.find((config) => config.service === "openai");
        if (openai) {
          setBaseUrl(openai.endpoint);
          setSaved(openai);
        }
        const ragflow = configs.find((config) => config.service === "ragflow");
        if (ragflow) {
          setRagflowBaseUrl(ragflow.endpoint);
          setRagflowSaved(ragflow);
        }
        const jev = configs.find((config) => config.service === "jev");
        if (jev) {
          setJevBaseUrl(jev.endpoint);
          setJevSaved(jev);
        }
      })
      .catch(() => undefined);
    commands
      .listScanRules()
      .then((rules) => {
        setRoots(rules.allowedRoots);
        setExclusions(rules.customExclusions);
        setFileCategories(rules.fileCategories ?? ["documents", "sourceCode"]);
        setDirectoryGroupThreshold(String(rules.directoryGroupThreshold ?? 5));
      })
      .catch(() => undefined);
    commands
      .getJevValuePolicy?.()
      .then((policy) => {
        setJevInstructions(policy.instructions);
        setJevCriteria(policy.criteria.join("\n"));
        setJevThreshold(String(policy.valuableThreshold));
      })
      .catch(() => undefined);
  }, [commands]);

  async function testJev() {
    setJevConnection(
      await commands.testServiceConnection({
        service: "jev",
        endpoint: jevBaseUrl,
        apiKey: jevApiKey,
      }),
    );
  }
  async function saveJev() {
    const result = await commands.saveSettings({
      service: "jev",
      endpoint: jevBaseUrl,
      apiKey: jevApiKey,
    });
    setJevSaved(result);
    setJevApiKey("");
  }

  async function saveJevPolicy() {
    setError(null);
    setJevPolicyNotice(null);
    const criteria = jevCriteria
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const valuableThreshold = Number(jevThreshold);
    if (!commands.saveJevValuePolicy) {
      setError("当前版本暂不支持保存 JEV 评估标准，请更新栖知后重试。");
      return;
    }
    try {
      const savedPolicy = await commands.saveJevValuePolicy({
        instructions: jevInstructions.trim(),
        criteria,
        valuableThreshold,
      });
      setJevInstructions(savedPolicy.instructions);
      setJevCriteria(savedPolicy.criteria.join("\n"));
      setJevThreshold(String(savedPolicy.valuableThreshold));
      setJevPolicyNotice(
        "评估标准已保存；现有文件会按新标准重新进行价值判断。",
      );
    } catch {
      setError(
        "评估标准未保存：说明不能为空，分级需要 2—10 项，阈值需位于最低分与最高分之间。",
      );
    }
  }

  async function chooseFolder(target: "roots" | "exclusions") {
    setError(null);
    try {
      const selected = await commands.pickFolder();
      if (!selected) return;
      const update = target === "roots" ? setRoots : setExclusions;
      update((current) =>
        current.includes(selected) ? current : [...current, selected],
      );
    } catch {
      setError("无法打开文件夹选择窗口，请重启栖知后重试。");
    }
  }

  async function saveScanRules() {
    setError(null);
    setScanRulesNotice(null);
    const parsedDirectoryGroupThreshold = Number(directoryGroupThreshold);
    if (
      !Number.isInteger(parsedDirectoryGroupThreshold) ||
      parsedDirectoryGroupThreshold < 2 ||
      parsedDirectoryGroupThreshold > 100
    ) {
      setError("目录聚合阈值必须在 2 到 100 之间。");
      return;
    }
    try {
      const savedRules = await commands.saveScanRules({
        allowedRoots: roots,
        customExclusions: exclusions,
        fileCategories,
        directoryGroupThreshold: parsedDirectoryGroupThreshold,
      });
      setRoots(savedRules.allowedRoots);
      setExclusions(savedRules.customExclusions);
      setFileCategories(savedRules.fileCategories);
      setDirectoryGroupThreshold(
        String(
          savedRules.directoryGroupThreshold ?? parsedDirectoryGroupThreshold,
        ),
      );
      setScanRulesNotice(
        `扫描规则已保存：${savedRules.allowedRoots.length} 个扫描范围，${savedRules.customExclusions.length} 个排除目录。`,
      );
      setNtfsIndexer((await commands.getNtfsIndexerStatus?.()) ?? null);
    } catch {
      setError("扫描范围未保存，请检查选择的文件夹。");
    }
  }

  function toggleFileCategory(category: FileCategory, checked: boolean) {
    setFileCategories((current) => {
      if (checked) {
        return current.includes(category) ? current : [...current, category];
      }
      return current.filter((item) => item !== category);
    });
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

  async function saveRagflow() {
    setError(null);
    try {
      const config = await commands.saveSettings({
        service: "ragflow",
        endpoint: ragflowBaseUrl,
        apiKey: ragflowApiKey,
      });
      setRagflowSaved(config);
      setRagflowApiKey("");
      setRagflowConnection({
        available: true,
        message: "RAGFlow 设置已保存，可前往知识库加载机器人。",
      });
    } catch {
      setError("RAGFlow 设置未保存，请检查 Base URL 和本机凭据服务。");
      setRagflowApiKey("");
    }
  }

  async function testRagflow() {
    setRagflowConnection(null);
    setRagflowConnection(
      await commands.testServiceConnection({
        service: "ragflow",
        endpoint: ragflowBaseUrl,
        apiKey: ragflowApiKey,
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
        <div className="path-section file-types">
          <h3>文件类型</h3>
          <p>
            仅展示后续可安全提取和分析的办公文档、文本和源代码；图片、视频、压缩包、程序等不会进入今日列表。
          </p>
          <label>
            <input
              type="checkbox"
              checked={fileCategories.includes("documents")}
              onChange={(event) =>
                toggleFileCategory("documents", event.currentTarget.checked)
              }
            />
            常见文档与文本（PDF、Office、Markdown、TXT、CSV 等）
          </label>
          <label>
            <input
              type="checkbox"
              checked={fileCategories.includes("sourceCode")}
              onChange={(event) =>
                toggleFileCategory("sourceCode", event.currentTarget.checked)
              }
            />
            常见编程语言源码（Python、JavaScript/TypeScript、Java、C/C++、Go、Rust
            等）
          </label>
        </div>
        <div className="path-section today-display-settings">
          <h3>今日页面展示</h3>
          <p>
            同一目录达到指定数量的变化文件或变化子目录后，在“今日”中折叠为目录组。
          </p>
          <label className="threshold-setting-row">
            <span className="threshold-setting-copy">
              <strong>目录聚合阈值</strong>
              <small>可设置 2–100，默认 5 项</small>
            </span>
            <span className="threshold-setting-control">
              <input
                aria-label="目录聚合阈值"
                max="100"
                min="2"
                onChange={(event) =>
                  setDirectoryGroupThreshold(event.currentTarget.value)
                }
                step="1"
                type="number"
                value={directoryGroupThreshold}
              />
              <span aria-hidden="true">项</span>
            </span>
          </label>
        </div>
        <div className="settings-block-actions">
          {scanRulesNotice ? (
            <p className="settings-success" role="status">
              {scanRulesNotice}
            </p>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="button primary"
            onClick={saveScanRules}
          >
            保存扫描范围
          </button>
        </div>
      </section>

      <SummarySettingsSection commands={commands} />

      <section className="settings-block" aria-labelledby="services-title">
        <div>
          <h2 id="services-title">连接服务</h2>
          <p>凭据保存在 Windows 凭据管理器中，界面只显示掩码。</p>
        </div>
        <article className="service-card">
          <div className="service-name">
            <span className="service-icon">⌕</span>
            <div>
              <h3>本地 NTFS 索引器</h3>
              <p>内置服务使用 NTFS 元数据和变更日志发现工作文件。</p>
              <p>无需启动或安装 Everything。</p>
            </div>
          </div>
          <p
            className={
              ntfsIndexer?.available ? "service-state ready" : "service-state"
            }
          >
            {ntfsIndexer?.available ? "索引服务已连接" : "索引服务待安装"}
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
        <article className="service-card openai-card">
          <div className="service-name">
            <span className="service-icon">T</span>
            <div>
              <h3>TypeSafe AI / JEV</h3>
              <p>用于自动评估可安全解析的新文档是否值得进入知识库。</p>
            </div>
          </div>
          <div className="service-form">
            <label>
              Base URL
              <input
                aria-label="JEV Base URL"
                value={jevBaseUrl}
                onChange={(event) => setJevBaseUrl(event.currentTarget.value)}
              />
            </label>
            <label>
              API Key
              <input
                aria-label="JEV API Key"
                type="password"
                value={jevApiKey}
                placeholder={jevSaved ? jevSaved.apiKeyMask : "填写后可测试"}
                onChange={(event) => setJevApiKey(event.currentTarget.value)}
              />
            </label>
            <div className="service-actions">
              <button
                type="button"
                className="button outline"
                onClick={() => void testJev()}
                disabled={!jevBaseUrl || !jevApiKey}
              >
                测试连接
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void saveJev()}
                disabled={!jevBaseUrl || !jevApiKey}
              >
                保存 JEV
              </button>
            </div>
            {jevConnection ? (
              <p
                className={
                  jevConnection.available
                    ? "connection-result ready"
                    : "connection-result"
                }
              >
                {jevConnection.message}
              </p>
            ) : null}
            <div className="jev-policy-form">
              <div className="jev-policy-heading">
                <h4>价值评估标准</h4>
                <p>
                  JEV 按从低到高的分级给出分数；达到阈值的文件会标记为“有价值”。
                </p>
              </div>
              <label>
                JEV 评估说明
                <textarea
                  aria-label="JEV 评估说明"
                  value={jevInstructions}
                  rows={4}
                  onChange={(event) =>
                    setJevInstructions(event.currentTarget.value)
                  }
                />
              </label>
              <label>
                JEV 分级标准
                <textarea
                  aria-label="JEV 分级标准"
                  value={jevCriteria}
                  rows={7}
                  onChange={(event) =>
                    setJevCriteria(event.currentTarget.value)
                  }
                />
                <span>每行一个等级，按价值从低到高排列（2—10 项）。</span>
              </label>
              <label className="jev-threshold-field">
                JEV 价值阈值
                <input
                  aria-label="JEV 价值阈值"
                  type="number"
                  min="0"
                  max={Math.max(
                    0,
                    jevCriteria.split(/\r?\n/).filter((line) => line.trim())
                      .length - 1,
                  )}
                  step="0.1"
                  value={jevThreshold}
                  onChange={(event) =>
                    setJevThreshold(event.currentTarget.value)
                  }
                />
              </label>
              <button
                type="button"
                className="button primary"
                onClick={() => void saveJevPolicy()}
              >
                保存评估标准
              </button>
              {jevPolicyNotice ? (
                <p className="connection-result ready" role="status">
                  {jevPolicyNotice}
                </p>
              ) : null}
            </div>
          </div>
        </article>
        <article className="service-card openai-card">
          <div className="service-name">
            <span className="service-icon">≡</span>
            <div>
              <h3>RAGFlow</h3>
              <p>用于选择已有问答机器人并检索知识库。</p>
            </div>
          </div>
          <div className="service-form">
            <label>
              Base URL
              <input
                aria-label="RAGFlow Base URL"
                value={ragflowBaseUrl}
                placeholder="http://ragflow.example.com"
                onChange={(event) =>
                  setRagflowBaseUrl(event.currentTarget.value)
                }
              />
            </label>
            <label>
              API Key
              <input
                aria-label="RAGFlow API Key"
                type="password"
                value={ragflowApiKey}
                placeholder={
                  ragflowSaved ? ragflowSaved.apiKeyMask : "填写后可测试"
                }
                onChange={(event) =>
                  setRagflowApiKey(event.currentTarget.value)
                }
              />
            </label>
            <div className="service-actions">
              <button
                type="button"
                className="button outline"
                onClick={testRagflow}
                disabled={!ragflowBaseUrl || !ragflowApiKey}
              >
                测试连接
              </button>
              <button
                type="button"
                className="button primary"
                onClick={saveRagflow}
                disabled={!ragflowBaseUrl || !ragflowApiKey}
              >
                保存 RAGFlow
              </button>
            </div>
            {ragflowConnection ? (
              <p
                className={
                  ragflowConnection.available
                    ? "connection-result ready"
                    : "connection-result"
                }
              >
                {ragflowConnection.available && !ragflowSaved
                  ? `${ragflowConnection.message}；请点击“保存 RAGFlow”后在知识库中使用。`
                  : ragflowConnection.message}
              </p>
            ) : null}
          </div>
        </article>
        <CodexSettingsSection commands={commands} />
      </section>
      {error ? (
        <p role="alert" className="settings-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
