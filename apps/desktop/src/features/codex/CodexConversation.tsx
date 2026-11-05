import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import type {
  CodexApprovalDecision,
  CodexConversationHistory,
  CodexHandoffDetails,
  CodexTurnEvent,
} from "../../lib/tauri";
import { CodexPendingMaterials } from "./CodexPendingMaterials";

export function CodexConversation({
  history,
  livePrompt,
  liveAnswer,
  events,
  running,
  disabledReason,
  onSend,
  onStop,
  onResolveApproval,
  pendingHandoffs,
  onDismissPending,
}: {
  history: CodexConversationHistory | null;
  livePrompt: string;
  liveAnswer: string;
  events: CodexTurnEvent[];
  running: boolean;
  disabledReason?: string;
  onSend: (value: string) => Promise<void>;
  onStop: () => Promise<void>;
  onResolveApproval: (
    requestId: string,
    decision: CodexApprovalDecision,
  ) => Promise<void>;
  pendingHandoffs?: CodexHandoffDetails[];
  onDismissPending?: (handoffId: string, materialId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const shouldFollow = useRef(true);
  useEffect(() => {
    if (
      shouldFollow.current &&
      typeof bottom.current?.scrollIntoView === "function"
    )
      bottom.current.scrollIntoView({ block: "end" });
  }, [history?.turns.length, liveAnswer]);
  function edit(text: string) {
    setDraft(text);
    window.setTimeout(() => composer.current?.focus(), 0);
  }
  function copy(id: string, text: string) {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1200);
  }
  async function submit() {
    const value = draft.trim();
    if (!value || running || submitting || disabledReason) return;
    setSubmitting(true);
    shouldFollow.current = true;
    setDraft("");
    try {
      await onSend(value);
    } finally {
      setSubmitting(false);
    }
  }
  const processEvents = events.filter((event) => event.type === "processItem");
  const approvals = events.filter(
    (event): event is Extract<CodexTurnEvent, { type: "approvalRequested" }> =>
      event.type === "approvalRequested",
  );
  return (
    <section className="codex-conversation-pane">
      <div
        className="codex-thread-scroll"
        ref={scrollArea}
        onScroll={() => {
          const node = scrollArea.current;
          if (node)
            shouldFollow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 96;
        }}
      >
        {!history?.turns.length && !livePrompt ? (
          <div className="codex-thread-empty">
            <span>✦</span>
            <h2>让 Codex 在这个项目中工作</h2>
            <p>
              它可以阅读右侧加入的资料，并在独立工作目录中生成文件、代码和文档。
            </p>
          </div>
        ) : null}
        {history?.turns.map((turn) => (
          <article className="codex-turn" key={turn.id}>
            {turn.messages.map((message) =>
              message.role === "user" ? (
                <div className="codex-message-stack user" key={message.id}>
                  <div className="codex-user-message">{message.markdown}</div>
                  <div className="codex-message-actions">
                    <button
                      type="button"
                      onClick={() => copy(message.id, message.markdown)}
                    >
                      {copiedId === message.id ? "已复制" : "复制"}
                    </button>
                    <button
                      type="button"
                      aria-label="编辑用户消息"
                      onClick={() => edit(message.markdown)}
                    >
                      编辑
                    </button>
                  </div>
                </div>
              ) : (
                <div className="codex-assistant-message" key={message.id}>
                  <div className="codex-avatar">✦</div>
                  <div className="codex-markdown">
                    <ReactMarkdown>{message.markdown}</ReactMarkdown>
                    {turn.processItems.length ? (
                      <details className="codex-process">
                        <summary>
                          查看执行过程（{turn.processItems.length}）
                        </summary>
                        {turn.processItems.map((item) => (
                          <div key={item.id}>
                            <strong>{item.title}</strong>
                            <span>{item.safeSummary}</span>
                          </div>
                        ))}
                      </details>
                    ) : null}
                    <div className="codex-message-actions assistant">
                      <button
                        type="button"
                        onClick={() => copy(message.id, message.markdown)}
                      >
                        {copiedId === message.id ? "已复制" : "复制"}
                      </button>
                    </div>
                  </div>
                </div>
              ),
            )}
          </article>
        ))}
        {livePrompt ? (
          <div className="codex-message-stack user">
            <div className="codex-user-message">{livePrompt}</div>
            <div className="codex-message-actions">
              <button type="button" onClick={() => copy("live", livePrompt)}>
                {copiedId === "live" ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                aria-label="编辑当前用户消息"
                onClick={() => edit(livePrompt)}
              >
                编辑
              </button>
            </div>
          </div>
        ) : null}
        {livePrompt ? (
          <div className="codex-assistant-message">
            <div className="codex-avatar">✦</div>
            <div className="codex-markdown">
              <ReactMarkdown>{liveAnswer || "正在思考…"}</ReactMarkdown>
              {processEvents.length ? (
                <details className="codex-process">
                  <summary>思考与执行过程（{processEvents.length}）</summary>
                  {processEvents.map((event, index) =>
                    event.type === "processItem" ? (
                      <div key={`${event.itemId}-${index}`}>
                        <strong>{event.title}</strong>
                        <span>{event.summary}</span>
                      </div>
                    ) : null,
                  )}
                </details>
              ) : null}
              {approvals.map((approval) => (
                <div className="codex-approval-card" key={approval.requestId}>
                  <strong>需要你的确认</strong>
                  <p>{approval.targetSummary}</p>
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        void onResolveApproval(approval.requestId, "decline")
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="primary"
                      type="button"
                      onClick={() =>
                        void onResolveApproval(approval.requestId, "accept")
                      }
                    >
                      允许一次
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div ref={bottom} />
      </div>
      <div className="codex-composer-shell">
        <CodexPendingMaterials
          handoffs={pendingHandoffs ?? []}
          disabled={running}
          onDismiss={onDismissPending ?? (async () => undefined)}
        />
        <div className="codex-composer">
          <textarea
            ref={composer}
            value={draft}
            disabled={Boolean(disabledReason)}
            placeholder={
              disabledReason ||
              "描述要完成的任务，Enter 发送，Shift + Enter 换行"
            }
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="codex-stop"
              onClick={() => void onStop()}
              aria-label="停止任务"
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="codex-send"
              onClick={() => void submit()}
              disabled={!draft.trim() || submitting || Boolean(disabledReason)}
              aria-label="发送任务"
            >
              ➤
            </button>
          )}
          <small>Codex 只在这个项目的工作目录中生成文件</small>
        </div>
      </div>
    </section>
  );
}
