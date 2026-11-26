import { FeedbackNotice, useFeedback } from "../../components/FeedbackNotice";
import { ControlIcon } from "../../components/ControlIcon";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { factoryHelpGroups, helpFor, type FactoryHelpId } from "./factory-help";
import { errorText, stateName, statusTone } from "./factory-model";

export function Badge({
  value,
  label,
  version = false,
}: {
  value: string;
  label?: string;
  version?: boolean;
}) {
  return (
    <span
      className={"fc-badge " + statusTone(value)}
      data-version-state={version ? value : undefined}
    >
      <i aria-hidden="true" />
      {label ?? stateName(value)}
    </span>
  );
}
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="live-facts">
      {rows
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([name, v]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="fc-empty">{children}</p>;
}

export function ContextHelp({
  id,
  label,
}: {
  id: FactoryHelpId;
  label?: string;
}) {
  const help = helpFor(id);
  const root = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const tooltipId = "factory-help-" + useId().replace(/:/g, "");
  const visible = !dismissed && (hovered || focused || pinned);

  useEffect(() => {
    if (!pinned) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPinned(false);
        setDismissed(true);
      }
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [pinned]);

  return (
    <span
      ref={root}
      className="live-context-help"
      onMouseEnter={() => {
        setDismissed(false);
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setDismissed(false);
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !visible) return;
        event.preventDefault();
        event.stopPropagation();
        setPinned(false);
        setDismissed(true);
      }}
    >
      <button
        type="button"
        className="live-context-help-trigger"
        aria-label={label ?? "解释：" + help.title}
        aria-describedby={visible ? tooltipId : undefined}
        aria-expanded={visible}
        onClick={() => {
          setDismissed(false);
          setPinned((value) => !value);
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {visible && (
        <span id={tooltipId} role="tooltip" className="live-context-popover">
          <strong>{help.title}</strong>
          <span>{help.description}</span>
          {help.detail && <small>{help.detail}</small>}
          {pinned && <small>按 Escape 关闭</small>}
        </span>
      )}
    </span>
  );
}
export function ReadNotice({
  read,
}: {
  read: {
    loading: boolean;
    data: unknown;
    error: string;
    retry: () => void;
    attempt?: number;
  };
}) {
  if (read.error)
    return (
      <div className="live-read-state">
        <FeedbackNotice
          tone="error"
          attempt={read.attempt}
          message={(read.data ? "显示上次读取结果。" : "") + read.error}
        />
        <span title={read.error}>
          {read.data ? "显示上次读取结果" : "读取失败"}
        </span>
        <button
          type="button"
          className="ui-action ui-quiet ui-small"
          onClick={read.retry}
          disabled={read.loading}
        >
          重新读取
        </button>
      </div>
    );
  if (!read.data && read.loading)
    return (
      <p role="status" className="fc-empty">
        正在读取…
      </p>
    );
  return null;
}
export function useAction(onSuccess?: () => void) {
  const notify = useFeedback();
  const [state, setState] = useState({ busy: false, error: false });
  const lock = useRef(false);
  async function run(action: () => Promise<string | void>) {
    if (lock.current) return;
    lock.current = true;
    notify(null);
    setState({ busy: true, error: false });
    try {
      const message = await action();
      if (message) notify(message, "success");
      setState({ busy: false, error: false });
      onSuccess?.();
    } catch (error) {
      notify(errorText(error), "error");
      setState({ busy: false, error: true });
    } finally {
      lock.current = false;
    }
  }
  return { ...state, run };
}
export function Modal({
  title,
  onClose,
  closeDisabled = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={"fc-modal live-modal" + (wide ? " assembly-modal-wide" : "")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!closeDisabled) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="ui-icon-button ui-close"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label="关闭窗口"
          title="关闭窗口"
        >
          <ControlIcon name="x" size={17} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function FactoryGuide() {
  return (
    <div className="live-guide">
      <p className="live-subtle">
        用于理解园区数字、连线和操作后果；它不会改变正在执行的工单。
      </p>
      {factoryHelpGroups.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <p>{group.description}</p>
          <dl>
            {group.ids.map((id) => {
              const item = helpFor(id);
              return (
                <div key={id}>
                  <dt>{item.title}</dt>
                  <dd>{item.description}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
export function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="live-filter">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Pagination({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  useEffect(() => {
    if (limit > 0 && offset > 0 && offset >= total) {
      onChange(Math.max(0, Math.floor((total - 1) / limit) * limit));
    }
  }, [offset, limit, total, onChange]);
  if (total <= limit && !offset) return null;
  return (
    <nav className="live-pagination" aria-label="列表分页">
      <button
        type="button"
        className="ui-action ui-small"
        disabled={offset <= 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        上一页
      </button>
      <span>
        {total === 0
          ? "0"
          : Math.min(total, offset + 1) +
            "–" +
            Math.min(total, offset + limit)}{" "}
        / {total}
      </span>
      <button
        type="button"
        className="ui-action ui-small"
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        下一页
      </button>
    </nav>
  );
}
export function EntryButton({
  title,
  meta,
  badge,
  onClick,
  children,
}: {
  title: string;
  meta?: string;
  badge?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" className="live-entry" onClick={onClick}>
      <strong>{title}</strong>
      {meta && <small>{meta}</small>}
      {badge && <Badge value={badge} />} {children}
    </button>
  );
}
