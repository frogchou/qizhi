import { useLayoutEffect, useRef } from "react";
import { ControlIcon } from "../../components/ControlIcon";
import type { AssemblyDraft } from "./assembly-model";

const title = "装配助手（描述智能体的工作内容由AI生成智能体）";

export function AssemblyBrief({
  initialBrief,
  messages,
  candidates,
  reply,
  active,
  readStatus,
  locked,
  canSubmit,
  pending,
  onReply,
  onSubmit,
  onTest,
}: {
  initialBrief: string;
  messages: AssemblyDraft["messages"];
  candidates: AssemblyDraft["candidates"];
  reply: string;
  active: boolean;
  readStatus?: string;
  locked: boolean;
  canSubmit: boolean;
  pending?: string;
  onReply: (text: string) => void;
  onSubmit: () => void;
  onTest: (candidateId: string) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const firstUserMessage = messages.find((message) => message.role === "user");
  const showInitial = Boolean(
    initialBrief.trim() &&
    initialBrief.trim() !== firstUserMessage?.content.trim(),
  );
  const ready = canSubmit && Boolean(reply.trim());
  const buildIds = new Set(candidates.map((candidate) => candidate.id));
  useLayoutEffect(() => {
    const element = log.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current && element.clientHeight > 0)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    if (active && follow.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [active, messages.length, pending, showInitial]);
  return (
    <section
      className="studio-card studio-brief"
      aria-labelledby="studio-brief-title"
    >
      <header className="studio-card-title">
        <ControlIcon name="terminal" size={19} />
        <h2 id="studio-brief-title" aria-label={title}>
          装配助手<small>（描述智能体的工作内容由AI生成智能体）</small>
        </h2>
      </header>
      <div
        ref={log}
        className="studio-dialogue"
        role="log"
        aria-label="装配对话"
        aria-live="polite"
        aria-relevant="additions text"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 40;
        }}
      >
        {readStatus ? (
          <p className="studio-dialogue-status">{readStatus}</p>
        ) : (
          <>
            {!showInitial && !messages.length && (
              <Message role="assistant">
                你希望智能体完成什么工作？可以告诉我它会收到什么材料，以及你希望它交付什么结果。
              </Message>
            )}
            {showInitial && (
              <Message role="user" label="初始工作描述">
                {initialBrief}
              </Message>
            )}
            {messages.map((message, index) => {
              const build = message.candidateId;
              return (
                <Message
                  key={
                    message.requestId ??
                    `${index}-${message.operationId ?? message.role}`
                  }
                  role={message.role}
                  onTest={
                    build && buildIds.has(build)
                      ? () => onTest(build)
                      : undefined
                  }
                >
                  {message.content}
                </Message>
              );
            })}
            {pending && <p className="studio-dialogue-status">{pending}</p>}
          </>
        )}
      </div>
      <form
        className="studio-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            follow.current = true;
            onSubmit();
          }
        }}
      >
        <textarea
          aria-label="给装配助手的消息"
          placeholder="描述智能体的工作，或继续补充要求…"
          value={reply}
          readOnly={locked}
          rows={2}
          onChange={(event) => onReply(event.target.value)}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              if (ready) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="studio-composer-actions">
          <small>Ctrl + Enter 发送</small>
          <button
            type="submit"
            className="ui-action ui-primary"
            disabled={!ready}
          >
            <ControlIcon name="layers" /> 一键装配
          </button>
        </div>
      </form>
    </section>
  );
}

function Message({
  role,
  label,
  children,
  onTest,
}: {
  role: string;
  label?: string;
  children: string;
  onTest?: () => void;
}) {
  const user = role === "user";
  return (
    <div className="studio-message" data-role={user ? "user" : "assistant"}>
      <span className="studio-speaker">
        {label || (user ? "你" : "装配助手")}
      </span>
      <p>{children}</p>
      {onTest && (
        <button
          type="button"
          className="ui-action ui-quiet ui-small"
          onClick={onTest}
        >
          测试此版本 →
        </button>
      )}
    </div>
  );
}
