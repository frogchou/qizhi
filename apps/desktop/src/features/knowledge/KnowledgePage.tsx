import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { StatusNotice } from "../../components/StatusNotice";
import type {
  QizhiCommands,
  RagflowAgent,
  RagflowDataset,
  RagflowKnowledgeQuery,
} from "../../lib/tauri";

const setupMessage = "请先在设置中保存 RAGFlow Base URL 和 API Key。";

type ConversationTurn = {
  id: string;
  question: string;
  status: "pending" | "completed" | "failed";
  result?: RagflowKnowledgeQuery;
  error?: string;
};

function errorText(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "无法读取 RAGFlow 资源，请稍后重试。";
}

function toggle(items: string[], id: string) {
  return items.includes(id)
    ? items.filter((item) => item !== id)
    : [...items, id];
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="10.8" cy="10.8" r="6.5" />
      <path d="m16 16 4.2 4.2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m4 4 16 8-16 8 3-8-3-8Z" />
      <path d="M7 12h12" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3.5v11" />
      <path d="m7.8 10.8 4.2 4.2 4.2-4.2" />
      <path d="M4.5 18.5v1.2c0 .7.6 1.3 1.3 1.3h12.4c.7 0 1.3-.6 1.3-1.3v-1.2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M3.8 7.6c0-1 .8-1.8 1.8-1.8h4l1.7 2h7.1c1 0 1.8.8 1.8 1.8v7.1c0 1-.8 1.8-1.8 1.8H5.6c-1 0-1.8-.8-1.8-1.8V7.6Z" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3.5 14 9l5.5 2-5.5 2L12 18.5 10 13l-5.5-2 5.5-2L12 3.5Z" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 5.8v4.5H9" />
      <path d="M12 8v4.3l2.8 1.7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function Composer({
  question,
  querying,
  hasResources,
  onChange,
  onSubmit,
  followUp,
}: {
  question: string;
  querying: boolean;
  hasResources: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  followUp: boolean;
}) {
  const label = followUp ? "继续提问" : "询问你的工作知识库";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form className="knowledge-composer" onSubmit={submit}>
      <SearchIcon />
      <label
        className="sr-only"
        htmlFor={followUp ? "follow-up" : "initial-question"}
      >
        {label}
      </label>
      <textarea
        aria-label={label}
        id={followUp ? "follow-up" : "initial-question"}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={
          followUp
            ? "继续提问，或针对以上内容进一步深入…"
            : "询问你的工作知识库"
        }
        rows={1}
        value={question}
      />
      <button
        aria-label="发送问题"
        className="composer-send"
        disabled={querying || !question.trim() || !hasResources}
        type="submit"
      >
        {querying ? (
          <span className="composer-loading">···</span>
        ) : (
          <SendIcon />
        )}
      </button>
    </form>
  );
}

function ResourceSelector({
  title,
  items,
  selectedIds,
  icon,
  loading,
  emptyText,
  onToggle,
}: {
  title: string;
  items: Array<RagflowDataset | RagflowAgent>;
  selectedIds: string[];
  icon: "folder" | "agent";
  loading: boolean;
  emptyText: string;
  onToggle: (id: string) => void;
}) {
  return (
    <details className="resource-selector">
      <summary>
        <span className="resource-summary-icon">
          {icon === "folder" ? <FolderIcon /> : <AgentIcon />}
        </span>
        <span>
          <strong>
            {title}（{selectedIds.length}）
          </strong>
          <small>
            {selectedIds.length ? `已选择 ${selectedIds.length} 项` : "可多选"}
          </small>
        </span>
        <ChevronIcon />
      </summary>
      <div className="resource-dropdown">
        {loading ? <p className="resource-empty">正在加载资源…</p> : null}
        {!loading && !items.length ? (
          <p className="resource-empty">{emptyText}</p>
        ) : null}
        {items.map((item) => (
          <label className="resource-row" key={item.id}>
            <input
              aria-label={item.name}
              checked={selectedIds.includes(item.id)}
              onChange={() => onToggle(item.id)}
              type="checkbox"
            />
            <span className="resource-row-icon">
              {icon === "folder" ? <FolderIcon /> : <AgentIcon />}
            </span>
            <span>
              <strong>{item.name}</strong>
              <small>
                {item.description ||
                  (icon === "folder" ? "用于资料检索" : "RAGFlow Agent")}
              </small>
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

function ConversationAnswer({
  turn,
  agents,
  downloadingChunkId,
  onDownload,
}: {
  turn: ConversationTurn;
  agents: RagflowAgent[];
  downloadingChunkId: string | null;
  onDownload: (chunk: RagflowKnowledgeQuery["chunks"][number]) => void;
}) {
  if (turn.status === "pending") {
    return (
      <article className="assistant-panel pending-answer">
        <div className="assistant-avatar">
          <AgentIcon />
        </div>
        <p>正在检索资料并向已选择的 Agents 提问…</p>
      </article>
    );
  }
  if (turn.status === "failed") {
    return (
      <article className="assistant-panel assistant-failure">
        <div className="assistant-avatar">
          <AgentIcon />
        </div>
        <p>{turn.error}</p>
      </article>
    );
  }
  const result = turn.result;
  const answers = result?.agentResults ?? [];
  const chunks = result?.chunks ?? [];
  return (
    <article className="assistant-panel">
      <div className="assistant-avatar">
        <AgentIcon />
      </div>
      <div className="assistant-content">
        {answers.length ? (
          answers.map((agentResult) => {
            const agent = agents.find(
              (item) => item.id === agentResult.agentId,
            );
            return (
              <section className="agent-answer" key={agentResult.agentId}>
                <header>
                  <strong>{agent?.name ?? agentResult.agentId}</strong>
                  <span>{agentResult.error ? "未完成" : "已回答"}</span>
                </header>
                <p
                  className={
                    agentResult.error ? "agent-error" : "knowledge-answer"
                  }
                >
                  {agentResult.error ??
                    agentResult.answer ??
                    "未返回回答内容。"}
                </p>
              </section>
            );
          })
        ) : (
          <p className="retrieval-summary">
            已从所选知识库中找到 {chunks.length} 条相关资料。
          </p>
        )}
        {chunks.length ? (
          <details className="citation-disclosure">
            <summary>引用来源（{chunks.length}）</summary>
            <div className="citation-list">
              {chunks.map((chunk) => (
                <article className="citation-card" key={chunk.id}>
                  <div className="citation-main">
                    <header>
                      <FolderIcon />
                      <strong>{chunk.documentName || "未命名来源"}</strong>
                    </header>
                    <p>{chunk.content}</p>
                    <small>相关度 {Math.round(chunk.similarity * 100)}%</small>
                  </div>
                  {chunk.datasetId && chunk.documentId ? (
                    <button
                      aria-label={`下载 ${chunk.documentName || "资料来源"}`}
                      className="citation-download"
                      disabled={downloadingChunkId === chunk.id}
                      onClick={() => onDownload(chunk)}
                      type="button"
                    >
                      <DownloadIcon />
                      {downloadingChunkId === chunk.id ? "下载中" : "下载"}
                    </button>
                  ) : (
                    <span className="citation-unavailable">仅来源片段</span>
                  )}
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function KnowledgePage({ commands }: { commands: QizhiCommands }) {
  const [datasets, setDatasets] = useState<RagflowDataset[]>([]);
  const [agents, setAgents] = useState<RagflowAgent[]>([]);
  const [datasetIds, setDatasetIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [recentQuestions, setRecentQuestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [downloadFeedback, setDownloadFeedback] = useState<string | null>(null);
  const [downloadingChunkId, setDownloadingChunkId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);

  const hasResources = datasetIds.length > 0 || agentIds.length > 0;
  const ragflowConnected = !loading && !error;
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  const load = useCallback(async () => {
    const listDatasets = commands.listRagflowDatasets;
    const listAgents = commands.listRagflowAgents;
    if (!listDatasets || !listAgents) {
      setError(setupMessage);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextDatasets, nextAgents] = await Promise.all([
        listDatasets(),
        listAgents(),
      ]);
      setDatasets(nextDatasets);
      setAgents(nextAgents);
      setDatasetIds((items) =>
        items.filter((id) => nextDatasets.some((item) => item.id === id)),
      );
      setAgentIds((items) =>
        items.filter((id) => nextAgents.some((item) => item.id === id)),
      );
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [commands]);

  useEffect(() => {
    void load();
  }, [load]);

  async function query() {
    const runQuery = commands.queryRagflowKnowledge;
    const normalizedQuestion = question.trim();
    if (!runQuery || !normalizedQuestion || !hasResources || querying) return;
    const turnId = `${Date.now()}-${turns.length}`;
    setTurns((items) => [
      ...items,
      { id: turnId, question: normalizedQuestion, status: "pending" },
    ]);
    setRecentQuestions((items) =>
      [
        normalizedQuestion,
        ...items.filter((item) => item !== normalizedQuestion),
      ].slice(0, 5),
    );
    setQuestion("");
    setQuerying(true);
    setError(null);
    try {
      const result = await runQuery({
        question: normalizedQuestion,
        datasetIds,
        agentIds,
      });
      setTurns((items) =>
        items.map((turn) =>
          turn.id === turnId ? { ...turn, status: "completed", result } : turn,
        ),
      );
    } catch (queryError) {
      setTurns((items) =>
        items.map((turn) =>
          turn.id === turnId
            ? { ...turn, status: "failed", error: errorText(queryError) }
            : turn,
        ),
      );
    } finally {
      setQuerying(false);
    }
  }

  async function downloadSource(
    chunk: RagflowKnowledgeQuery["chunks"][number],
  ) {
    const download = commands.downloadRagflowDocument;
    if (!download || !chunk.datasetId || !chunk.documentId) {
      setDownloadFeedback("该来源未提供可下载的原文件标识。");
      return;
    }
    const fallbackName = "ragflow-document";
    const savePath = await save({
      defaultPath: chunk.documentName || fallbackName,
      title: "保存 RAGFlow 原文件",
    });
    if (typeof savePath !== "string" || !savePath) return;
    setDownloadingChunkId(chunk.id);
    setDownloadFeedback(null);
    try {
      const result = await download({
        datasetId: chunk.datasetId,
        documentId: chunk.documentId,
        savePath,
      });
      setDownloadFeedback(`已下载：${result.savedPath}`);
    } catch (downloadError) {
      setDownloadFeedback(errorText(downloadError));
    } finally {
      setDownloadingChunkId(null);
    }
  }

  return (
    <section className="page knowledge-page" aria-labelledby="knowledge-title">
      <header className="knowledge-header">
        <div>
          <h1 id="knowledge-title">知识库问答</h1>
          <p>
            基于你选择的知识库，结合 RAGFlow
            进行检索与生成，帮你快速获得可信、可追溯的答案。
          </p>
        </div>
        <button
          className="button secondary knowledge-reload"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? "正在加载…" : "重新加载资源"}
        </button>
      </header>
      {error ? <StatusNotice>{error}</StatusNotice> : null}
      <div className="knowledge-layout-v2">
        <section aria-label="知识库对话" className="knowledge-conversation">
          <div className="conversation-scroll" aria-live="polite">
            {!turns.length ? (
              <div className="conversation-start">
                <p>在右侧选择资料范围后，在底部输入问题即可开始检索和对话。</p>
              </div>
            ) : (
              <div className="conversation-turns">
                {turns.map((turn) => (
                  <div className="conversation-turn" key={turn.id}>
                    <article className="user-message">
                      <span>你</span>
                      <p>{turn.question}</p>
                    </article>
                    <ConversationAnswer
                      turn={turn}
                      agents={Array.from(agentById.values())}
                      downloadingChunkId={downloadingChunkId}
                      onDownload={(chunk) => void downloadSource(chunk)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="conversation-follow-up">
            {downloadFeedback ? (
              <p className="conversation-feedback" role="status">
                {downloadFeedback}
              </p>
            ) : null}
            <Composer
              question={question}
              querying={querying}
              hasResources={hasResources}
              onChange={setQuestion}
              onSubmit={() => void query()}
              followUp={turns.length > 0}
            />
          </div>
        </section>
        <aside aria-label="检索范围" className="knowledge-rail">
          <section className="rail-card scope-card">
            <h2>检索范围</h2>
            <p>选择要检索的知识库，并向所选 Agents 同时提问。</p>
            <ResourceSelector
              title="知识库"
              items={datasets}
              selectedIds={datasetIds}
              icon="folder"
              loading={loading}
              emptyText="暂无可访问知识库。"
              onToggle={(id) => setDatasetIds((items) => toggle(items, id))}
            />
            <ResourceSelector
              title="Agents"
              items={agents}
              selectedIds={agentIds}
              icon="agent"
              loading={loading}
              emptyText="暂无可访问 Agents。"
              onToggle={(id) => setAgentIds((items) => toggle(items, id))}
            />
          </section>
          <section
            className={
              ragflowConnected
                ? "rail-card connection-card"
                : "rail-card connection-card connection-card-offline"
            }
          >
            <span className="connection-dot" />
            <div>
              <strong>
                {ragflowConnected ? "RAGFlow 已连接" : "RAGFlow 连接需要检查"}
              </strong>
              <small>
                {ragflowConnected
                  ? "本地部署 · 已使用安全凭据"
                  : "请在设置中检查服务地址与 API Key"}
              </small>
            </div>
            <ChevronIcon />
          </section>
          <section className="rail-card recent-card">
            <header>
              <h2>近期检索内容</h2>
              {recentQuestions.length ? (
                <button onClick={() => setRecentQuestions([])} type="button">
                  清空
                </button>
              ) : null}
            </header>
            {recentQuestions.length ? (
              <ul>
                {recentQuestions.map((item) => (
                  <li key={item}>
                    <HistoryIcon />
                    <button onClick={() => setQuestion(item)} type="button">
                      {item}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="recent-empty">本次会话的检索问题会显示在这里。</p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
