import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";

import { BreakableText } from "../../components/BreakableText";
import { StatusNotice } from "../../components/StatusNotice";
import type {
  CodexHandoffResult,
  CodexHandoffSourceInput,
  KnowledgeQueryStreamEvent,
  QizhiCommands,
  RagflowAgent,
  RagflowAgentReference,
  RagflowAgentSource,
  RagflowAgentStep,
  RagflowChunk,
  RagflowDataset,
} from "../../lib/tauri";
import { CodexDestinationDialog } from "../codex/CodexDestinationDialog";

const setupMessage = "请先在设置中保存 RAGFlow Base URL 和 API Key。";

type AgentConversationState = {
  agentId: string;
  status: "pending" | "streaming" | "completed" | "failed";
  answerMarkdown: string;
  references: RagflowAgentReference[];
  sources: RagflowAgentSource[];
  steps: RagflowAgentStep[];
  thinking: boolean;
  error: string | null;
  sessionId: string | null;
};

type ConversationTurn = {
  id: string;
  question: string;
  status: "pending" | "completed" | "failed";
  chunks: RagflowChunk[];
  retrievalError: string | null;
  agents: AgentConversationState[];
  selectionToken: string | null;
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
  inputRef,
}: {
  question: string;
  querying: boolean;
  hasResources: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  followUp: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const label = followUp ? "继续提问" : "询问你的工作知识库";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    if (!querying && question.trim() && hasResources) onSubmit();
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
        onKeyDown={handleKeyDown}
        placeholder={
          followUp
            ? "继续提问，或针对以上内容进一步深入…"
            : "询问你的工作知识库"
        }
        ref={inputRef}
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

function MessageActions({
  copyLabel,
  editLabel,
  content,
  onCopy,
  onEdit,
}: {
  copyLabel: string;
  editLabel: string;
  content: string;
  onCopy: (content: string) => void;
  onEdit: (content: string) => void;
}) {
  return (
    <div className="message-actions">
      <button
        aria-label={copyLabel}
        onClick={() => onCopy(content)}
        type="button"
      >
        复制
      </button>
      <button
        aria-label={editLabel}
        onClick={() => onEdit(content)}
        type="button"
      >
        编辑
      </button>
    </div>
  );
}

function citationMarkdown(
  markdown: string,
  references: RagflowAgentReference[],
) {
  const citationIds = new Set(
    references.map((reference) => reference.citationId),
  );
  return markdown.replace(/\[ID:([^\]\s]+)\]/g, (marker, citationId) =>
    citationIds.has(citationId)
      ? `[Fig.${citationId}](#qizhi-citation-${encodeURIComponent(citationId)})`
      : marker,
  );
}

function InlineCitation({ reference }: { reference: RagflowAgentReference }) {
  const similarity = Math.round(reference.similarity * 100);
  return (
    <span className="inline-citation">
      <button
        aria-label={`查看引用 Fig.${reference.citationId}`}
        className="inline-citation-trigger"
        type="button"
      >
        Fig.{reference.citationId}
      </button>
      <span className="inline-citation-popover" role="tooltip">
        <strong>{reference.documentName || "未命名来源"}</strong>
        <span>{reference.content || "该引用未返回可展示的知识片段。"}</span>
        {reference.similarity > 0 ? <small>相关度 {similarity}%</small> : null}
      </span>
    </span>
  );
}

function ConversationAnswer({
  turn,
  agents,
  downloadingChunkId,
  onDownload,
  onCopy,
  onEdit,
  onSendChunks,
  onSendDocuments,
  onSendAgent,
}: {
  turn: ConversationTurn;
  agents: RagflowAgent[];
  downloadingChunkId: string | null;
  onDownload: (chunk: RagflowChunk) => void;
  onCopy: (content: string) => void;
  onEdit: (content: string) => void;
  onSendChunks: (turn: ConversationTurn, chunks: RagflowChunk[]) => void;
  onSendDocuments: (
    turn: ConversationTurn,
    sources: RagflowAgentSource[],
  ) => void;
  onSendAgent: (
    turn: ConversationTurn,
    agent: AgentConversationState,
    name: string,
  ) => void;
}) {
  const [selectedChunkIds, setSelectedChunkIds] = useState<Set<string>>(
    new Set(),
  );
  if (turn.status === "failed" && !turn.agents.length && !turn.chunks.length) {
    return (
      <article className="assistant-panel assistant-failure">
        <div className="assistant-avatar">
          <AgentIcon />
        </div>
        <p>{turn.error}</p>
      </article>
    );
  }
  return (
    <div className="assistant-response-group">
      {turn.agents.map((agentState) => {
        const agent = agents.find((item) => item.id === agentState.agentId);
        const name = agent?.name ?? agentState.agentId;
        return (
          <article className="assistant-panel" key={agentState.agentId}>
            <div className="assistant-avatar">
              <AgentIcon />
            </div>
            <section className="agent-answer">
              <header>
                <strong>{name}</strong>
                <span>
                  {agentState.thinking
                    ? "正在处理"
                    : agentState.status === "failed"
                      ? "未完成"
                      : agentState.status === "completed"
                        ? "已回答"
                        : "生成中"}
                </span>
              </header>
              {agentState.answerMarkdown ? (
                <div className="knowledge-answer markdown-body">
                  <ReactMarkdown
                    components={{
                      a: ({ href, children, ...props }) => {
                        const prefix = "#qizhi-citation-";
                        if (href?.startsWith(prefix)) {
                          const citationId = decodeURIComponent(
                            href.slice(prefix.length),
                          );
                          const reference = agentState.references.find(
                            (item) => item.citationId === citationId,
                          );
                          return reference ? (
                            <InlineCitation reference={reference} />
                          ) : (
                            <>{children}</>
                          );
                        }
                        return (
                          <a
                            {...props}
                            href={href}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {children}
                          </a>
                        );
                      },
                      p: ({ children }) =>
                        typeof children === "string" ? (
                          <p>
                            <BreakableText value={children} />
                          </p>
                        ) : (
                          <p>{children}</p>
                        ),
                    }}
                  >
                    {citationMarkdown(
                      agentState.answerMarkdown,
                      agentState.references,
                    )}
                  </ReactMarkdown>
                </div>
              ) : agentState.error ? null : (
                <p className="agent-pending">正在生成回答…</p>
              )}
              {agentState.error ? (
                <p className="agent-error">
                  {agentState.error}
                  {agentState.answerMarkdown ? "（已保留部分回答）" : ""}
                </p>
              ) : null}
              {agentState.answerMarkdown ? (
                <div className="agent-answer-actions">
                  <MessageActions
                    copyLabel={`复制 ${name} 回答`}
                    editLabel={`编辑 ${name} 回答`}
                    content={agentState.answerMarkdown}
                    onCopy={onCopy}
                    onEdit={onEdit}
                  />
                  <button
                    aria-label={`发送 ${name} 回答到 Codex`}
                    onClick={() => onSendAgent(turn, agentState, name)}
                    type="button"
                  >
                    发送到 Codex
                  </button>
                </div>
              ) : null}
              {agentState.steps.length ? (
                <details className="agent-execution">
                  <summary>思考与执行过程（{agentState.steps.length}）</summary>
                  <ol>
                    {agentState.steps.map((step, index) => (
                      <li key={`${step.title}-${index}`}>
                        <strong>{step.title}</strong>
                        <span>
                          {step.status}
                          {step.elapsedMs != null
                            ? ` · ${step.elapsedMs} ms`
                            : ""}
                        </span>
                        {step.error ? <small>{step.error}</small> : null}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              {agentState.sources.length ? (
                <section
                  aria-label={`${name} 引用资料`}
                  className="agent-source-documents"
                >
                  <h4>引用资料（{agentState.sources.length}）</h4>
                  <div className="agent-source-list">
                    {agentState.sources.map((source) => {
                      const sourceId = `${source.datasetId}:${source.documentId}:${source.documentName}`;
                      const canDownload = Boolean(
                        source.datasetId && source.documentId,
                      );
                      return (
                        <article className="agent-source-card" key={sourceId}>
                          <FolderIcon />
                          <span>
                            <strong>
                              {source.documentName || "未命名来源"}
                            </strong>
                            <small>{source.citationCount} 处引用</small>
                          </span>
                          <button
                            aria-label={`下载来源 ${source.documentName || "未命名来源"}`}
                            disabled={
                              !canDownload || downloadingChunkId === sourceId
                            }
                            onClick={() =>
                              onDownload({
                                id: sourceId,
                                content: "",
                                documentName: source.documentName,
                                documentId: source.documentId,
                                datasetId: source.datasetId,
                                similarity: 0,
                              })
                            }
                            type="button"
                          >
                            <DownloadIcon />
                            {downloadingChunkId === sourceId
                              ? "下载中"
                              : "下载"}
                          </button>
                          {canDownload ? (
                            <button
                              aria-label={`发送原文 ${source.documentName || "未命名来源"} 到 Codex`}
                              onClick={() => onSendDocuments(turn, [source])}
                              type="button"
                            >
                              发送原文
                            </button>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </section>
          </article>
        );
      })}
      {!turn.agents.length ? (
        <article className="assistant-panel retrieval-answer">
          <div className="assistant-avatar">
            <FolderIcon />
          </div>
          <div className="assistant-content">
            <p>
              {turn.status === "pending"
                ? "正在检索知识库…"
                : `已从所选知识库中找到 ${turn.chunks.length} 条相关资料。`}
            </p>
          </div>
        </article>
      ) : null}
      {turn.retrievalError ? (
        <p className="retrieval-error">
          知识库检索未完成：{turn.retrievalError}
        </p>
      ) : null}
      {turn.error && (turn.agents.length || turn.chunks.length) ? (
        <p className="retrieval-error">本轮问答未完成：{turn.error}</p>
      ) : null}
      {turn.chunks.length ? (
        <details className="citation-disclosure">
          <summary>引用来源（{turn.chunks.length}）</summary>
          <div className="citation-selection-actions">
            <span>已选 {selectedChunkIds.size} 条片段</span>
            <button
              disabled={selectedChunkIds.size === 0}
              onClick={() =>
                onSendChunks(
                  turn,
                  turn.chunks.filter((chunk) => selectedChunkIds.has(chunk.id)),
                )
              }
              type="button"
            >
              发送所选片段到 Codex
            </button>
          </div>
          <div className="citation-list">
            {turn.chunks.map((chunk) => (
              <article className="citation-card" key={chunk.id}>
                <input
                  aria-label={`选择片段 ${chunk.documentName || "未命名来源"}`}
                  checked={selectedChunkIds.has(chunk.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedChunkIds((current) => {
                      const next = new Set(current);
                      if (checked) next.add(chunk.id);
                      else next.delete(chunk.id);
                      return next;
                    });
                  }}
                  type="checkbox"
                />
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
  );
}

function applyStreamEvent(
  turn: ConversationTurn,
  event: KnowledgeQueryStreamEvent,
): ConversationTurn {
  if (turn.status === "completed" || turn.status === "failed") return turn;
  if (event.kind === "retrievalCompleted") {
    return { ...turn, chunks: event.chunks };
  }
  if (event.kind === "retrievalFailed") {
    return { ...turn, retrievalError: event.error };
  }
  if (!event.kind.startsWith("agent")) return turn;
  const agentId = "agentId" in event ? event.agentId : "";
  const agents = turn.agents.map((agent) => {
    if (
      agent.agentId !== agentId ||
      agent.status === "completed" ||
      agent.status === "failed"
    ) {
      return agent;
    }
    switch (event.kind) {
      case "agentStarted":
        return { ...agent, status: "streaming" as const };
      case "agentAnswerReset":
        return {
          ...agent,
          answerMarkdown: "",
          status: "streaming" as const,
        };
      case "agentDelta":
        return {
          ...agent,
          answerMarkdown: agent.answerMarkdown + event.delta,
          status: "streaming" as const,
        };
      case "agentThinking":
        return {
          ...agent,
          thinking: event.active,
          status: "streaming" as const,
        };
      case "agentStep":
        return { ...agent, steps: [...agent.steps, event.step] };
      case "agentReferences":
        return {
          ...agent,
          references: event.references,
          sources: event.sources,
        };
      case "agentCompleted":
        return {
          ...agent,
          status: "completed" as const,
          thinking: false,
          sessionId: event.sessionId,
        };
      case "agentFailed":
        return {
          ...agent,
          status: "failed" as const,
          thinking: false,
          error: event.error,
        };
      default:
        return agent;
    }
  });
  return { ...turn, agents };
}

export function KnowledgePage({
  commands,
  hidden = false,
  onOpenCodex,
}: {
  commands: QizhiCommands;
  hidden?: boolean;
  onOpenCodex?: (result: CodexHandoffResult) => void;
}) {
  const [datasets, setDatasets] = useState<RagflowDataset[]>([]);
  const [agents, setAgents] = useState<RagflowAgent[]>([]);
  const [datasetIds, setDatasetIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [agentSessions, setAgentSessions] = useState<Record<string, string>>(
    {},
  );
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [recentQuestions, setRecentQuestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [downloadingChunkId, setDownloadingChunkId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [codexSource, setCodexSource] =
    useState<CodexHandoffSourceInput | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);

  const hasResources = datasetIds.length > 0 || agentIds.length > 0;
  const ragflowConnected = !loading && !error;
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  function sendChunksToCodex(turn: ConversationTurn, chunks: RagflowChunk[]) {
    if (!chunks.length) return;
    const retrievedAtUtcMs = Date.now();
    setCodexSource({
      kind: "ragflowChunks",
      question: turn.question,
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.id,
        content: chunk.content,
        documentName: chunk.documentName,
        documentId: chunk.documentId,
        datasetId: chunk.datasetId,
        similarity: chunk.similarity,
        retrievedAtUtcMs,
      })),
    });
  }

  function sendDocumentsToCodex(
    turn: ConversationTurn,
    sources: RagflowAgentSource[],
  ) {
    const retrievedAtUtcMs = Date.now();
    const unique = new Map(
      sources
        .filter((source) => source.datasetId && source.documentId)
        .map((source) => [
          `${source.datasetId}:${source.documentId}`,
          {
            datasetId: source.datasetId,
            documentId: source.documentId,
            documentName: source.documentName || "未命名来源",
            retrievedAtUtcMs,
          },
        ]),
    );
    if (!unique.size || !turn.selectionToken) return;
    setCodexSource({
      kind: "ragflowDocuments",
      selectionToken: turn.selectionToken,
      documents: [...unique.values()],
    });
  }

  function sendAgentToCodex(
    turn: ConversationTurn,
    agent: AgentConversationState,
    name: string,
  ) {
    if (!agent.answerMarkdown) return;
    setCodexSource({
      kind: "ragflowAnswer",
      answer: {
        question: turn.question,
        agentId: agent.agentId,
        agentName: name,
        finalAnswer: agent.answerMarkdown,
        retrievedAtUtcMs: Date.now(),
        references: agent.references.map((reference) => ({
          citationId: reference.citationId,
          chunkId: reference.chunkId,
          content: reference.content,
          documentName: reference.documentName,
          documentId: reference.documentId,
          datasetId: reference.datasetId,
          similarity: reference.similarity,
          retrievedAtUtcMs: Date.now(),
        })),
      },
    });
  }

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

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followOutputRef.current) node.scrollTop = node.scrollHeight;
  }, [turns]);

  function editInComposer(content: string) {
    setQuestion(content);
    followOutputRef.current = true;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.scrollIntoView({ block: "nearest" });
    });
  }

  async function copyMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setFeedback("已复制到剪贴板");
    } catch {
      setFeedback("复制失败，请手动选择文本。");
    }
  }

  async function query() {
    const runQuery = commands.queryRagflowKnowledge;
    const normalizedQuestion = question.trim();
    if (!runQuery || !normalizedQuestion || !hasResources || querying) return;
    const turnId = `${Date.now()}-${turns.length}`;
    const initialAgents = agentIds.map<AgentConversationState>((agentId) => ({
      agentId,
      status: "pending",
      answerMarkdown: "",
      references: [],
      sources: [],
      steps: [],
      thinking: false,
      error: null,
      sessionId: agentSessions[agentId] ?? null,
    }));
    setTurns((items) => [
      ...items,
      {
        id: turnId,
        question: normalizedQuestion,
        status: "pending",
        chunks: [],
        retrievalError: null,
        agents: initialAgents,
        selectionToken: null,
      },
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
    followOutputRef.current = true;
    try {
      const selectedSessions = Object.fromEntries(
        agentIds.flatMap((id) =>
          agentSessions[id] ? [[id, agentSessions[id]]] : [],
        ),
      );
      const result = await runQuery(
        {
          question: normalizedQuestion,
          datasetIds,
          agentIds,
          agentSessions: selectedSessions,
        },
        (event) => {
          setTurns((items) =>
            items.map((turn) =>
              turn.id === turnId ? applyStreamEvent(turn, event) : turn,
            ),
          );
        },
      );
      const finalAgents = initialAgents.map((initial) => {
        const final = result.agentResults.find(
          (item) => item.agentId === initial.agentId,
        );
        if (!final) {
          return {
            ...initial,
            status: "failed" as const,
            error: "Agent 未返回结果。",
          };
        }
        return {
          ...initial,
          status: final.error ? ("failed" as const) : ("completed" as const),
          answerMarkdown: final.answer ?? "",
          references: final.references ?? [],
          sources: final.sources ?? [],
          steps: final.steps ?? [],
          error: final.error,
          sessionId: final.sessionId ?? null,
          thinking: false,
        };
      });
      const hasSuccessfulRetrieval =
        datasetIds.length > 0 && !result.retrievalError;
      const hasSuccessfulAgent = finalAgents.some(
        (agent) => agent.status === "completed",
      );
      const turnSucceeded = hasSuccessfulRetrieval || hasSuccessfulAgent;
      setTurns((items) =>
        items.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: turnSucceeded ? "completed" : "failed",
                error: turnSucceeded
                  ? undefined
                  : "所选知识库和 Agents 均未能返回结果。",
                chunks: result.chunks,
                retrievalError: result.retrievalError ?? null,
                agents: finalAgents,
                selectionToken: result.selectionToken ?? null,
              }
            : turn,
        ),
      );
      setAgentSessions((sessions) => {
        const next = { ...sessions };
        for (const item of result.agentResults) {
          if (item.sessionInvalid) delete next[item.agentId];
          else if (item.sessionId) next[item.agentId] = item.sessionId;
        }
        return next;
      });
    } catch (queryError) {
      setTurns((items) =>
        items.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: "failed",
                error: errorText(queryError),
                agents: turn.agents.map((agent) =>
                  agent.status === "completed" || agent.status === "failed"
                    ? agent
                    : {
                        ...agent,
                        status: "failed",
                        thinking: false,
                        error: "回答被中断。",
                      },
                ),
              }
            : turn,
        ),
      );
    } finally {
      setQuerying(false);
    }
  }

  async function downloadSource(chunk: RagflowChunk) {
    const download = commands.downloadRagflowDocument;
    if (!download || !chunk.datasetId || !chunk.documentId) {
      setFeedback("该来源未提供可下载的原文件标识。");
      return;
    }
    const savePath = await save({
      defaultPath: chunk.documentName || "ragflow-document",
      title: "保存 RAGFlow 原文件",
    });
    if (typeof savePath !== "string" || !savePath) return;
    setDownloadingChunkId(chunk.id);
    setFeedback(null);
    try {
      const result = await download({
        datasetId: chunk.datasetId,
        documentId: chunk.documentId,
        savePath,
      });
      setFeedback(`已下载：${result.savedPath}`);
    } catch (downloadError) {
      setFeedback(errorText(downloadError));
    } finally {
      setDownloadingChunkId(null);
    }
  }

  return (
    <section
      aria-labelledby="knowledge-title"
      className="page knowledge-page"
      hidden={hidden}
      style={hidden ? { display: "none" } : undefined}
    >
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
          <div
            className="conversation-scroll"
            aria-live="polite"
            onScroll={(event) => {
              const node = event.currentTarget;
              followOutputRef.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
            ref={scrollRef}
          >
            {!turns.length ? (
              <div className="conversation-start">
                <p>在右侧选择资料范围后，在底部输入问题即可开始检索和对话。</p>
              </div>
            ) : (
              <div className="conversation-turns">
                {turns.map((turn) => (
                  <div className="conversation-turn" key={turn.id}>
                    <article className="user-message">
                      <div className="user-message-bubble">
                        <p>{turn.question}</p>
                        <MessageActions
                          copyLabel={`复制 ${turn.question}`}
                          editLabel={`编辑 ${turn.question}`}
                          content={turn.question}
                          onCopy={(content) => void copyMessage(content)}
                          onEdit={editInComposer}
                        />
                      </div>
                    </article>
                    <ConversationAnswer
                      turn={turn}
                      agents={Array.from(agentById.values())}
                      downloadingChunkId={downloadingChunkId}
                      onDownload={(chunk) => void downloadSource(chunk)}
                      onCopy={(content) => void copyMessage(content)}
                      onEdit={editInComposer}
                      onSendChunks={sendChunksToCodex}
                      onSendDocuments={sendDocumentsToCodex}
                      onSendAgent={sendAgentToCodex}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="conversation-follow-up">
            {feedback ? (
              <p className="conversation-feedback" role="status">
                {feedback}
              </p>
            ) : null}
            <Composer
              question={question}
              querying={querying}
              hasResources={hasResources}
              onChange={setQuestion}
              onSubmit={() => void query()}
              followUp={turns.length > 0}
              inputRef={inputRef}
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
                    <button onClick={() => editInComposer(item)} type="button">
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
      {codexSource ? (
        <CodexDestinationDialog
          commands={commands}
          onClose={() => setCodexSource(null)}
          onCommitted={(result) => {
            setCodexSource(null);
            onOpenCodex?.(result);
          }}
          source={codexSource}
        />
      ) : null}
    </section>
  );
}
