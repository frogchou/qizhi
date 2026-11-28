import { useFeedback } from "../../components/FeedbackNotice";
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import { AutoGrowTextarea } from "../../components/AutoGrowTextarea";
import type {
  CodexApprovalDecision,
  CodexConversationHistory,
  CodexHandoffDetails,
  CodexTurnEvent,
} from "../../lib/tauri";
import { CodexPendingMaterials } from "./CodexPendingMaterials";

export function CodexConversation({
  history,
  liveTurnId,
  livePrompt,
  liveAnswer,
  events,
  running,
  disabledReason,
  conversationReady = true,
  onSend,
  onStop,
  onResolveApproval,
  pendingHandoffs,
  onDismissPending,
  basketAttachment,
  attachingBasket = false,
}: {
  history: CodexConversationHistory | null;
  liveTurnId?: string | null;
  livePrompt: string;
  liveAnswer: string;
  events: CodexTurnEvent[];
  running: boolean;
  disabledReason?: string;
  conversationReady?: boolean;
  onSend: (value: string) => Promise<void>;
  onStop: () => Promise<void>;
  onResolveApproval: (
    requestId: string,
    decision: CodexApprovalDecision,
  ) => Promise<void>;
  pendingHandoffs?: CodexHandoffDetails[];
  basketAttachment?: ReactNode;
  attachingBasket?: boolean;
  onDismissPending?: (handoffId: string, materialId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const notify = useFeedback();
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(
    null,
  );
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
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("已复制到剪贴板", "success");
    } catch {
      notify("复制失败，请手动选择文本。", "error");
    }
  }
  const canSubmit =
    conversationReady &&
    !!draft.trim() &&
    !running &&
    !submitting &&
    !attachingBasket &&
    !disabledReason;
  async function submit() {
    if (!canSubmit) return;
    const value = draft.trim();
    setSubmitting(true);
    shouldFollow.current = true;
    setDraft("");
    try {
      await onSend(value);
    } finally {
      setSubmitting(false);
    }
  }
  async function resolveApproval(
    requestId: string,
    decision: CodexApprovalDecision,
  ) {
    if (resolvingApprovalId) return;
    setResolvingApprovalId(requestId);
    try {
      await onResolveApproval(requestId, decision);
    } finally {
      setResolvingApprovalId(null);
    }
  }
  const visibleHistoryTurns =
    history?.turns.filter((turn) => turn.id !== liveTurnId) ?? [];
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
        {visibleHistoryTurns.map((turn) => (
          <article className="codex-turn" key={turn.id}>
            {turn.messages.map((message) =>
              message.role === "user" ? (
                <div className="codex-message-stack user" key={message.id}>
                  <div className="codex-user-message">{message.markdown}</div>
                  <div className="codex-message-actions">
                    <button
                      type="button"
                      onClick={() => void copy(message.markdown)}
                    >
                      复制
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
                        onClick={() => void copy(message.markdown)}
                      >
                        复制
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
              <button type="button" onClick={() => void copy(livePrompt)}>
                复制
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
                      disabled={resolvingApprovalId === approval.requestId}
                      onClick={() =>
                        void resolveApproval(approval.requestId, "decline")
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={resolvingApprovalId === approval.requestId}
                      onClick={() =>
                        void resolveApproval(approval.requestId, "accept")
                      }
                    >
                      {resolvingApprovalId === approval.requestId
                        ? "处理中…"
                        : "允许一次"}
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
          <AutoGrowTextarea
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
          <div className="codex-composer-toolbar">
            {basketAttachment}
            <div className="codex-composer-submit">
              {running ? (
                <button
                  type="button"
                  className="codex-stop"
                  onClick={() => void onStop()}
                  aria-label="停止任务"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                  >
                    <rect
                      x="5"
                      y="5"
                      width="10"
                      height="10"
                      rx="2"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="codex-send"
                  onClick={() => void submit()}
                  disabled={!canSubmit}
                  aria-label="发送任务"
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 15.5v-11M5.2 9.3 10 4.5l4.8 4.8" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
