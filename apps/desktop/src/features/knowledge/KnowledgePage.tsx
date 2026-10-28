import { useCallback, useEffect, useState } from "react";

import { StatusNotice } from "../../components/StatusNotice";
import type {
  QizhiCommands,
  RagflowAgent,
  RagflowDataset,
  RagflowKnowledgeQuery,
} from "../../lib/tauri";

const setupMessage = "请先在设置中保存 RAGFlow Base URL 和 API Key。";
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

export function KnowledgePage({ commands }: { commands: QizhiCommands }) {
  const [datasets, setDatasets] = useState<RagflowDataset[]>([]);
  const [agents, setAgents] = useState<RagflowAgent[]>([]);
  const [datasetIds, setDatasetIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<RagflowKnowledgeQuery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
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
    if (
      !runQuery ||
      !question.trim() ||
      (datasetIds.length === 0 && agentIds.length === 0)
    )
      return;
    setQuerying(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await runQuery({ question: question.trim(), datasetIds, agentIds }),
      );
    } catch (queryError) {
      setError(errorText(queryError));
    } finally {
      setQuerying(false);
    }
  }
  return (
    <section className="page knowledge-page" aria-labelledby="knowledge-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">RAGFlow 工作台</p>
          <h1 id="knowledge-title">知识库</h1>
          <p className="muted">检索相关内容，并向选中的 Agents 同时提问。</p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "正在加载…" : "重新加载资源"}
        </button>
      </header>
      {error ? <StatusNotice>{error}</StatusNotice> : null}
      <div className="knowledge-workspace">
        <section className="knowledge-card knowledge-controls">
          <div className="resource-columns">
            <fieldset disabled={loading}>
              <legend>选择知识库</legend>
              {datasets.length ? (
                datasets.map((dataset) => (
                  <label className="resource-option" key={dataset.id}>
                    <input
                      aria-label={dataset.name}
                      type="checkbox"
                      checked={datasetIds.includes(dataset.id)}
                      onChange={() =>
                        setDatasetIds((items) => toggle(items, dataset.id))
                      }
                    />
                    <span>
                      <strong>{dataset.name}</strong>
                      <small>
                        {dataset.description || "用于直接检索相关片段"}
                      </small>
                    </span>
                  </label>
                ))
              ) : (
                <p className="empty">暂无可访问知识库。</p>
              )}
            </fieldset>
            <fieldset disabled={loading}>
              <legend>选择 Agents</legend>
              {agents.length ? (
                agents.map((agent) => (
                  <label className="resource-option" key={agent.id}>
                    <input
                      aria-label={agent.name}
                      type="checkbox"
                      checked={agentIds.includes(agent.id)}
                      onChange={() =>
                        setAgentIds((items) => toggle(items, agent.id))
                      }
                    />
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.description || "RAGFlow Agent"}</small>
                    </span>
                  </label>
                ))
              ) : (
                <p className="empty">暂无可访问 Agents。</p>
              )}
            </fieldset>
          </div>
          <label className="question-input">
            关键词或问题
            <textarea
              aria-label="关键词或问题"
              value={question}
              placeholder="例如：项目进度和当前风险"
              onChange={(event) => setQuestion(event.currentTarget.value)}
            />
          </label>
          <div className="knowledge-actions">
            <button
              className="button primary"
              type="button"
              disabled={
                querying ||
                !question.trim() ||
                (datasetIds.length === 0 && agentIds.length === 0)
              }
              onClick={query}
            >
              {querying ? "正在查询…" : "查询"}
            </button>
          </div>
        </section>
        <section className="knowledge-results" aria-live="polite">
          <article className="knowledge-card">
            <p className="eyebrow">相关内容</p>
            {result?.chunks.length ? (
              result.chunks.map((chunk) => (
                <div className="result-item" key={chunk.id}>
                  <strong>{chunk.documentName || "未命名来源"}</strong>
                  <p>{chunk.content}</p>
                  <small>相关度 {Math.round(chunk.similarity * 100)}%</small>
                </div>
              ))
            ) : (
              <p className="empty">
                选择知识库并查询后，相关片段将显示在这里。
              </p>
            )}
          </article>
          <article className="knowledge-card">
            <p className="eyebrow">Agent 回答</p>
            {result?.agentResults.length ? (
              result.agentResults.map((agentResult) => {
                const agent = agents.find(
                  (item) => item.id === agentResult.agentId,
                );
                return (
                  <div className="result-item" key={agentResult.agentId}>
                    <strong>{agent?.name ?? agentResult.agentId}</strong>
                    <p
                      className={
                        agentResult.error ? "agent-error" : "knowledge-answer"
                      }
                    >
                      {agentResult.error ?? agentResult.answer}
                    </p>
                  </div>
                );
              })
            ) : (
              <p className="empty">
                选择 Agents 并查询后，每个回答将独立显示在这里。
              </p>
            )}
          </article>
        </section>
      </div>
    </section>
  );
}
