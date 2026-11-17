import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ControlIcon } from "../../components/ControlIcon";
import {
  MaterialBasketSelector,
  useMaterialBasket,
} from "../materials/MaterialBasket";
import { basketError, basketUnavailable } from "../materials/basket-types";
import type { BasketAttachment } from "../materials/basket-types";
import type { CodexHandoffResult } from "../../lib/tauri";

export function CodexBasketAttachment({
  projectId,
  conversationId,
  locked,
  onBusy,
  onAttach,
  onAttached,
}: {
  projectId: string;
  conversationId: string;
  locked: boolean;
  onBusy: (busy: boolean) => void;
  onAttach?: (input: BasketAttachment) => Promise<CodexHandoffResult>;
  onAttached: (result: CodexHandoffResult) => Promise<void>;
}) {
  const basket = useMaterialBasket();
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(false);
  const active = useRef(false),
    attempt = useRef<{ key: string; id: string } | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [position, setPosition] = useState({
    left: 12,
    top: 0,
    width: 376,
    maxHeight: 400,
    above: true,
  });
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = Math.max(1, Math.min(380, window.innerWidth - 24));
      const above =
        anchor.top >= 250 || anchor.top > window.innerHeight - anchor.bottom;
      const maxHeight = Math.max(
        1,
        (above ? anchor.top : window.innerHeight - anchor.bottom) - 20,
      );
      setPosition({
        left: Math.max(
          12,
          Math.min(anchor.left, window.innerWidth - 12 - width),
        ),
        width,
        top: above ? anchor.top - 8 : anchor.bottom + 8,
        maxHeight,
        above,
      });
    };
    place();
    panel.current?.focus({ preventScroll: true });
    const outside = (e: MouseEvent) => {
      if (
        e.target instanceof Node &&
        !panel.current?.contains(e.target) &&
        !trigger.current?.contains(e.target)
      )
        close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const tabbable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),[tabindex="0"]',
        ),
      ).filter((el) => el.getClientRects().length);
      const first = tabbable[0],
        last = tabbable[tabbable.length - 1];
      if (!first || !last) return;
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === panel.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    const scroll = (e: Event) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return;
      place();
    };
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, close]);
  const missing = selected.some(
    (id) => !basket.items.some((item) => item.id === id),
  );
  async function attach() {
    if (active.current || locked || !selected.length || missing || !onAttach)
      return;
    const ids = [...new Set(selected)],
      key = JSON.stringify([projectId, conversationId, [...ids].sort()]);
    if (attempt.current?.key !== key)
      attempt.current = { key, id: crypto.randomUUID() };
    active.current = true;
    setBusy(true);
    onBusy(true);
    setNotice("");
    setError(false);
    try {
      const result = await onAttach({
        itemIds: ids,
        projectId,
        conversationId,
        requestId: attempt.current.id,
      });
      if (
        result.projectId !== projectId ||
        result.conversationId !== conversationId ||
        !result.handoffId
      )
        throw new Error("未能确认材料已添加到该会话，请重新读取");
      await onAttached(result);
      setSelected([]);
      close();
      setNotice(
        "已添加 " + result.itemCount + " 项到当前会话，将随下一条消息发送。",
      );
      attempt.current = null;
    } catch (reason) {
      setNotice(basketError(reason));
      setError(true);
    } finally {
      active.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div className="codex-attachment">
      <button
        ref={trigger}
        type="button"
        className="ui-action ui-quiet ui-small codex-attachment-trigger"
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        disabled={locked}
        aria-busy={busy}
        onClick={() => {
          if (open) close();
          else {
            setNotice("");
            setOpen(true);
          }
        }}
      >
        <ControlIcon name="basket" size={16} />
        <span>从资料筐添加</span>
      </button>
      {open &&
        createPortal(
          <div
            id={panelId}
            role="dialog"
            aria-label="从资料筐添加"
            tabIndex={-1}
            ref={panel}
            className="codex-attachment-panel"
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
              transform: position.above ? "translateY(-100%)" : undefined,
            }}
          >
            <div className="codex-attachment-heading">
              <span>
                <ControlIcon name="basket" size={18} />
                从资料筐添加
              </span>
              <button
                type="button"
                className="ui-icon-button ui-close"
                onClick={close}
                aria-label="关闭资料选择"
              >
                <ControlIcon name="x" size={16} />
              </button>
            </div>
            <div className="codex-attachment-items">
              <MaterialBasketSelector
                selectedIds={selected}
                onChange={setSelected}
                disabled={busy || locked}
                initiallyOpen
              />
              {basket.supported && !onAttach && <p>{basketUnavailable}</p>}
            </div>
            <footer>
              {error && notice && <p role="alert">{notice}</p>}
              <button
                type="button"
                className="ui-action ui-primary ui-small"
                disabled={
                  !onAttach ||
                  !basket.supported ||
                  !selected.length ||
                  missing ||
                  locked ||
                  busy ||
                  !!basket.error
                }
                onClick={() => void attach()}
              >
                <ControlIcon name="plus" size={15} />
                {busy ? "正在添加…" : "添加到当前会话"}
              </button>
            </footer>
          </div>,
          document.body,
        )}
      {notice && (!open || !error) && (
        <p
          className={
            error ? "codex-attachment-error" : "codex-attachment-announcement"
          }
          role={error ? "alert" : "status"}
        >
          {notice}
        </p>
      )}
    </div>
  );
}
