import { useEffect, useState } from "react";

import { StatusNotice } from "../../components/StatusNotice";
import type { QizhiCommands, RagflowChat } from "../../lib/tauri";

const setupMessage = "请先在设置中保存 RAGFlow Base URL 和 API Key。";

export function KnowledgePage({ commands }: { commands: QizhiCommands }) {
  const [chats, setChats] = useState<RagflowChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const listChats = commands.listRagflowChats;
    if (!listChats) {
      setError(setupMessage);
      setLoading(false);
      return;
    }
    listChats()
      .then((items) => {
        setChats(items);
        setSelectedChatId(items[0]?.id ?? "");
      })
      .catch(() => setError(setupMessage))
      .finally(() => setLoading(false));
  }, [commands]);

  async function ask() {
    const askChat = commands.askRagflowChat;
    if (!askChat || !selectedChatId || !question.trim()) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      const response = await askChat({
        chatId: selectedChatId,
        question: question.trim(),
      });
      setAnswer(response.answer);
    } catch {
      setError("本次问答未完成，请检查 RAGFlow 连接或稍后重试。");
    } finally {
      setAsking(false);
    }
  }

  return (
    <section className="page knowledge-page" aria-labelledby="knowledge-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">RAGFlow 问答</p>
          <h1 id="knowledge-title">知识库</h1>
          <p className="muted">选择已有问答机器人，栖知不会修改知识库内容。</p>
        </div>
      </header>
      {error ? <StatusNotice>{error}</StatusNotice> : null}
      <div className="knowledge-layout">
        <section className="knowledge-card">
          <label>
            选择问答机器人
            <select
              aria-label="选择问答机器人"
              value={selectedChatId}
              disabled={loading || chats.length === 0}
              onChange={(event) => {
                setSelectedChatId(event.currentTarget.value);
                setAnswer(null);
              }}
            >
              {chats.length === 0 ? (
                <option value="">暂无可用机器人</option>
              ) : null}
              {chats.map((chat) => (
                <option value={chat.id} key={chat.id}>
                  {chat.name}
                </option>
              ))}
            </select>
          </label>
          {selectedChatId ? (
            <p className="muted knowledge-description">
              {chats.find((chat) => chat.id === selectedChatId)?.description ||
                "使用该机器人的知识库配置进行问答。"}
            </p>
          ) : null}
          <label>
            问题
            <textarea
              aria-label="问题"
              value={question}
              disabled={loading || !selectedChatId}
              placeholder="例如：帮我梳理这项工作的关键要求"
              onChange={(event) => setQuestion(event.currentTarget.value)}
            />
          </label>
          <div className="knowledge-actions">
            <button
              type="button"
              className="button primary"
              disabled={asking || !selectedChatId || !question.trim()}
              onClick={ask}
            >
              {asking ? "正在提问…" : "发送"}
            </button>
          </div>
        </section>
        <section className="knowledge-card answer-card" aria-live="polite">
          <p className="eyebrow">回答</p>
          {answer ? (
            <p className="knowledge-answer">{answer}</p>
          ) : (
            <p className="empty">选择机器人并发送问题后，回答将显示在这里。</p>
          )}
        </section>
      </div>
    </section>
  );
}
