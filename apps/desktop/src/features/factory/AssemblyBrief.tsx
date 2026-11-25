import { ControlIcon } from "../../components/ControlIcon";
import type { AssemblyDraft } from "./assembly-model";

export function AssemblyBrief({
  description,
  messages,
  reply,
  locked,
  canSuggest,
  open,
  onOpen,
  onDescription,
  onReply,
  onSuggest,
}: {
  description: string;
  messages: AssemblyDraft["messages"];
  reply: string;
  locked: boolean;
  canSuggest: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onDescription: (text: string) => void;
  onReply: (text: string) => void;
  onSuggest: (text: string) => void;
}) {
  return (
    <section
      className="studio-card studio-brief"
      aria-labelledby="studio-brief-title"
    >
      <header className="studio-card-title">
        <ControlIcon name="terminal" size={19} />
        <h2 id="studio-brief-title">工作委托</h2>
      </header>
      <div className="studio-brief-input">
        <textarea
          aria-label="工作委托"
          value={description}
          disabled={locked}
          rows={2}
          placeholder="描述希望智能体完成的工作，以及要交付的结果"
          onChange={(event) => onDescription(event.target.value)}
        />
        <button
          type="button"
          className="ui-action"
          disabled={!canSuggest || !description.trim()}
          onClick={() => {
            onOpen(true);
            onSuggest(description);
          }}
        >
          整理工作委托
        </button>
      </div>
      <details
        className="studio-conversation"
        open={open}
        onToggle={(event) => onOpen(event.currentTarget.open)}
      >
        <summary>
          与装配助手沟通
          {messages.length > 0 && <span>{messages.length} 条消息</span>}
        </summary>
        {messages.map((message, i) => (
          <div key={i} className="assembly-message">
            <b>{message.role === "user" ? "你" : "中台助手"}</b>
            <p>{message.content}</p>
          </div>
        ))}
        <label className="assembly-field">
          给装配助手的消息
          <textarea
            rows={2}
            disabled={locked}
            value={reply}
            placeholder="补充工作约束，或回答助手的追问"
            onChange={(e) => onReply(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ui-action"
          disabled={!canSuggest || !reply.trim()}
          onClick={() => onSuggest(reply)}
        >
          发送给装配助手
        </button>
      </details>
    </section>
  );
}
