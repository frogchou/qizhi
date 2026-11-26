import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ControlIcon } from "./ControlIcon";
import "./feedback.css";

export type FeedbackTone = "info" | "success" | "error";
type Visibility = () => boolean;
type Notice = {
  source: string;
  sequence: number;
  message: string;
  tone: FeedbackTone;
  visible: Visibility;
};
type Feedback = {
  publish: (
    source: string,
    message: string | null | undefined,
    tone: FeedbackTone,
    visible: Visibility,
  ) => void;
  removeHidden: () => void;
};

const FeedbackContext = createContext<Feedback | null>(null);
const VisibilityContext = createContext({
  active: true,
  visible: () => !document.hidden,
});

// Retained pages keep their input and ongoing work when the user navigates away.
export function FeedbackScope({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const parent = useContext(VisibilityContext);
  const feedback = useContext(FeedbackContext);
  const shown = useRef(active);
  useLayoutEffect(() => {
    shown.current = active;
    if (!active) feedback?.removeHidden();
    return () => {
      shown.current = false;
      feedback?.removeHidden();
    };
  }, [active, feedback]);
  const visible = useCallback(
    () => shown.current && parent.visible(),
    [parent.visible],
  );
  const scope = useMemo(
    () => ({ active: active && parent.active, visible }),
    [active, parent.active, visible],
  );
  return (
    <VisibilityContext.Provider value={scope}>
      {children}
    </VisibilityContext.Provider>
  );
}

/** Call from the operation that completed so two identical receipts are separate events. */
export function useFeedback(defaultTone: FeedbackTone = "info", active = true) {
  const feedback = useContext(FeedbackContext);
  const parent = useContext(VisibilityContext);
  const enabled = useRef(active);
  useLayoutEffect(() => {
    enabled.current = active;
    if (!active) feedback?.removeHidden();
  }, [active, feedback]);
  const visible = useCallback(
    () => enabled.current && parent.visible(),
    [parent.visible],
  );
  const source = useId();
  return useCallback(
    (message: string | null | undefined, tone: FeedbackTone = defaultTone) =>
      feedback?.publish(source, message, tone, visible),
    [feedback, source, visible, defaultTone],
  );
}

/** Reports a change in an observed condition once, including polling failures. */
export function FeedbackNotice({
  message,
  tone = "info",
  attempt = 0,
}: {
  message?: string | null;
  tone?: FeedbackTone;
  attempt?: number;
}) {
  const notify = useFeedback(tone);
  const { active, visible } = useContext(VisibilityContext);
  const marker = useRef<HTMLSpanElement>(null);
  const reported = useRef<{ message: string; attempt: number } | null>(null);
  useEffect(() => {
    if (!message) {
      reported.current = null;
      notify(null);
      return;
    }
    if (
      !active ||
      !visible() ||
      marker.current?.parentElement?.closest(
        "[hidden], [inert], details:not([open])",
      )
    )
      return;
    if (
      reported.current?.message === message &&
      reported.current.attempt === attempt
    )
      return;
    reported.current = { message, attempt };
    notify(message);
  }, [message, notify, attempt, active, visible]);
  useEffect(
    () => () => {
      reported.current = null;
      notify(null);
    },
    [notify],
  );
  return <span hidden ref={marker} />;
}

function Bubble({
  notice,
  dismiss,
}: {
  notice: Notice;
  dismiss: (sequence: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const lines = notice.message.split("\n");
  const longMessage = notice.message.length > 150 || lines.length > 3;
  useEffect(() => {
    if (hovered || focused) return;
    const timeout = window.setTimeout(
      () => dismiss(notice.sequence),
      notice.tone === "error" ? 8000 : 4500,
    );
    return () => window.clearTimeout(timeout);
  }, [notice, dismiss, hovered, focused]);
  return (
    <div
      className="workspace-toast"
      data-tone={notice.tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => {
        if (
          event.relatedTarget instanceof HTMLElement &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          previousFocus.current = event.relatedTarget;
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
    >
      <ControlIcon
        name={notice.tone === "success" ? "check" : "info"}
        size={17}
      />
      <div
        className="workspace-toast-message"
        role={notice.tone === "error" ? "alert" : "status"}
        aria-atomic="true"
        tabIndex={longMessage ? 0 : undefined}
      >
        {lines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </div>
      <button
        type="button"
        className="workspace-toast-close"
        aria-label="关闭提示"
        onClick={() => {
          if (previousFocus.current?.isConnected)
            previousFocus.current.focus({ preventScroll: true });
          dismiss(notice.sequence);
        }}
      >
        <ControlIcon name="x" size={15} />
      </button>
    </div>
  );
}

const dialogSelector = 'dialog[open], [role="dialog"][aria-modal="true"]';
function feedbackHost() {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(dialogSelector),
  ).filter((dialog) => !dialog.closest("[hidden], [inert]"));
  // A native modal makes the rest of the document inert, regardless of z-index.
  const native = dialogs.filter((dialog) => dialog.tagName === "DIALOG");
  const focused = document.activeElement?.closest<HTMLElement>("dialog[open]");
  if (focused && native.includes(focused)) return focused;
  return (
    native[native.length - 1] ?? dialogs[dialogs.length - 1] ?? document.body
  );
}

function FeedbackViewport({
  notices,
  dismiss,
}: {
  notices: Notice[];
  dismiss: (sequence: number) => void;
}) {
  const [host, setHost] = useState(feedbackHost);
  useLayoutEffect(() => {
    const update = () => setHost(feedbackHost());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "hidden", "inert", "aria-modal"],
    });
    return () => observer.disconnect();
  }, []);
  return createPortal(
    <div className="desktop-feedback" role="region" aria-label="桌面提示">
      {notices.map((notice) => (
        <Bubble key={notice.sequence} notice={notice} dismiss={dismiss} />
      ))}
    </div>,
    host,
  );
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextSequence = useRef(0);
  const feedback = useMemo<Feedback>(
    () => ({
      publish(source, message, tone, visible) {
        const notice =
          message && visible()
            ? {
                source,
                message,
                tone,
                visible,
                sequence: ++nextSequence.current,
              }
            : null;
        setNotices((current) => {
          const others = current.filter(
            (item) =>
              item.source !== source &&
              (!notice ||
                item.message !== notice.message ||
                item.tone !== notice.tone),
          );
          if (!notice)
            return others.length === current.length ? current : others;
          return [...others.slice(-2), notice];
        });
      },
      removeHidden() {
        setNotices((current) =>
          current.some((item) => !item.visible())
            ? current.filter((item) => item.visible())
            : current,
        );
      },
    }),
    [],
  );
  useEffect(() => {
    document.addEventListener("visibilitychange", feedback.removeHidden);
    return () =>
      document.removeEventListener("visibilitychange", feedback.removeHidden);
  }, [feedback]);
  const dismiss = useCallback((sequence: number) => {
    setNotices((current) =>
      current.filter((item) => item.sequence !== sequence),
    );
  }, []);
  return (
    <FeedbackContext.Provider value={feedback}>
      {children}
      {notices.length > 0 && (
        <FeedbackViewport notices={notices} dismiss={dismiss} />
      )}
    </FeedbackContext.Provider>
  );
}
