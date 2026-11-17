import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ControlIcon } from "../../components/ControlIcon";
import { tauriCommands, type QizhiCommands } from "../../lib/tauri";
import {
  basketError,
  basketResultMessage,
  basketSize,
  basketUnavailable,
  type BasketItem,
  type BasketSource,
  type BasketResult,
} from "./basket-types";
import "./basket.css";

type BasketState = {
  supported: boolean;
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  error: string;
  items: BasketItem[];
  refresh: () => Promise<void>;
  add: (source: BasketSource) => Promise<BasketResult[]>;
  pick: () => Promise<BasketResult[]>;
  remove: (ids: string[]) => Promise<void>;
  clear: () => Promise<void>;
};
const unavailable = async (): Promise<never> => {
  throw new Error(basketUnavailable);
};
const Context = createContext<BasketState>({
  supported: false,
  loaded: false,
  loading: false,
  busy: false,
  error: "",
  items: [],
  refresh: unavailable,
  add: unavailable,
  pick: unavailable,
  remove: unavailable,
  clear: unavailable,
});
export const useMaterialBasket = () => useContext(Context);

export function MaterialBasketProvider({
  commands,
  children,
}: {
  commands: QizhiCommands;
  children: ReactNode;
}) {
  const supported =
    Boolean(commands.listBasket) &&
    (commands !== tauriCommands || "__TAURI_INTERNALS__" in window);
  const [items, setItems] = useState<BasketItem[]>([]),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    revision = useRef(0);
  const refresh = useCallback(async () => {
    if (!supported || !commands.listBasket) return;
    const request = ++revision.current;
    setLoading(true);
    try {
      const data = await commands.listBasket();
      if (!Array.isArray(data)) throw new Error("资料筐没有返回可用的条目列表");
      if (request === revision.current) {
        setItems(data);
        setLoaded(true);
        setError("");
      }
    } catch (reason) {
      if (request === revision.current) setError(basketError(reason));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [commands, supported]);
  useEffect(() => {
    if (!supported) return;
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      revision.current++;
      window.removeEventListener("focus", focus);
    };
  }, [supported, refresh]);
  async function change<T>(operation: () => Promise<T>) {
    if (!supported) throw new Error(basketUnavailable);
    if (lock.current) throw new Error("正在更新资料筐，请等当前操作完成");
    lock.current = true;
    setBusy(true);
    try {
      const result = await operation();
      await refresh();
      return result;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Context.Provider
      value={{
        supported,
        items,
        loaded,
        loading,
        error,
        busy,
        refresh,
        add: (source) =>
          change(() => commands.addToBasket?.(source) ?? unavailable()),
        pick: () => change(() => commands.pickBasketLocal?.() ?? unavailable()),
        remove: (ids) =>
          change(
            () =>
              commands.removeFromBasket?.([...new Set(ids)]) ?? unavailable(),
          ),
        clear: () => change(() => commands.clearBasket?.() ?? unavailable()),
      }}
    >
      {children}
    </Context.Provider>
  );
}

function Availability({ basket }: { basket: BasketState }) {
  if (!basket.supported)
    return <p className="basket-note">{basketUnavailable}</p>;
  if (basket.error)
    return (
      <div role="alert" className="basket-note basket-error">
        <span>{basket.error}</span>
        <button
          type="button"
          className="ui-action ui-quiet ui-small"
          onClick={() => void basket.refresh()}
        >
          重新读取
        </button>
      </div>
    );
  if (!basket.loaded)
    return (
      <p role="status" className="basket-note">
        正在读取资料筐…
      </p>
    );
  return null;
}
const kindNames: Record<BasketItem["kind"], string> = {
  local: "本地文件",
  today: "今日文件",
  recent: "近期文件",
  ragflowChunk: "知识片段",
  ragflowDocument: "知识库原件",
};

function ItemName({ item }: { item: BasketItem }) {
  const sourceLabel =
    item.kind === "local" && /^(本地|本机文件)$/u.test(item.sourceLabel.trim())
      ? kindNames.local
      : item.sourceLabel;
  const source = [
    ...new Set(
      [kindNames[item.kind], ...sourceLabel.split(/\s*·\s*/u)]
        .map((p) => p.trim())
        .filter((part) => part && part !== item.displayName),
    ),
  ].join(" · ");
  return (
    <>
      <span
        aria-hidden="true"
        className={
          "basket-file-icon" +
          (item.kind === "ragflowChunk" || item.kind === "ragflowDocument"
            ? " knowledge"
            : "")
        }
      >
        <ControlIcon
          name={item.kind === "ragflowChunk" ? "layers" : "file"}
          size={17}
        />
      </span>
      <span className="basket-item-name">
        <strong title={item.displayName}>{item.displayName}</strong>
        <small title={source}>{source}</small>
      </span>
      <span className="basket-size">{basketSize(item.sizeBytes)}</span>
    </>
  );
}
function SelectAll({
  checked,
  mixed,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="basket-select-all">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      {children}
    </label>
  );
}
function toggle(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export function MaterialBasketSelector({
  selectedIds,
  onChange,
  disabled = false,
  initiallyOpen = false,
  compact = false,
  leadingAction,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  initiallyOpen?: boolean;
  compact?: boolean;
  leadingAction?: ReactNode;
}) {
  const basket = useMaterialBasket(),
    panelId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const ids = [...new Set(selectedIds)],
    index = new Map(basket.items.map((item) => [item.id, item])),
    selected = new Set(ids);
  const pickedCount = basket.items.filter((item) =>
      selected.has(item.id),
    ).length,
    all = basket.items.length > 0 && pickedCount === basket.items.length;
  const locked = disabled || basket.busy;
  function expand() {
    if (!open) void basket.refresh();
    setOpen(!open);
  }
  return (
    <section
      className={[
        "basket-select",
        compact ? "basket-select-compact" : "",
        open ? "is-open" : "",
        initiallyOpen ? "starts-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="从资料筐选择材料"
    >
      <div className="basket-select-head">
        {leadingAction}
        {initiallyOpen ? (
          <strong>选择材料</strong>
        ) : (
          <button
            type="button"
            className="ui-action ui-small basket-select-trigger"
            aria-label="从资料筐选择"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={expand}
            disabled={disabled}
          >
            <ControlIcon name="basket" size={15} />
            <span>从资料筐选择</span>
            {compact && ids.length > 0 && (
              <span className="basket-inline-count" aria-hidden="true">
                {ids.length}
              </span>
            )}
            <span className="basket-arrow" aria-hidden="true">
              <ControlIcon name="chevron" size={13} />
            </span>
          </button>
        )}
        {(!compact || initiallyOpen) && <small>已选 {ids.length} 项</small>}
      </div>
      {ids.length > 0 && (
        <ul className="basket-picked" aria-label="已选资料筐材料">
          {ids.map((id) => {
            const item = index.get(id),
              missing = basket.loaded && !basket.error && !item;
            return (
              <li key={id} data-missing={missing}>
                <ControlIcon name="paperclip" size={13} />
                <span title={item?.displayName}>
                  {item?.displayName ??
                    (missing ? "已从资料筐移除" : "等待读取资料") + " · " + id}
                </span>
                <button
                  type="button"
                  className="ui-icon-button basket-chip-remove"
                  disabled={disabled}
                  aria-label={"移除已选资料 " + (item?.displayName ?? id)}
                  onClick={() => onChange(ids.filter((x) => x !== id))}
                >
                  <ControlIcon name="x" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <div className="basket-select-rows" id={panelId}>
          <Availability basket={basket} />
          {basket.supported &&
            basket.loaded &&
            (basket.items.length ? (
              <>
                <div className="basket-embedded-toolbar">
                  <SelectAll
                    checked={all}
                    mixed={!all && pickedCount > 0}
                    disabled={locked}
                    onChange={() =>
                      onChange(
                        all
                          ? ids.filter((id) => !index.has(id))
                          : [...new Set([...ids, ...index.keys()])],
                      )
                    }
                  >
                    全选筐中资料
                  </SelectAll>
                  <span>{basket.items.length} 项</span>
                </div>
                <div className="basket-items">
                  {basket.items.map((item) => (
                    <label
                      className="basket-item"
                      key={item.id}
                      data-selected={selected.has(item.id)}
                    >
                      <input
                        type="checkbox"
                        aria-label={"选择筐中资料 " + item.displayName}
                        checked={selected.has(item.id)}
                        disabled={locked}
                        onChange={() => onChange(toggle(ids, item.id))}
                      />
                      <ItemName item={item} />
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p className="basket-note basket-embedded-empty">
                <ControlIcon name="basket" size={16} />
                资料筐为空
              </p>
            ))}
        </div>
      )}
      {!open && !basket.supported && <Availability basket={basket} />}
    </section>
  );
}

export function MaterialBasketDialog({ close }: { close: () => void }) {
  const basket = useMaterialBasket(),
    ref = useRef<HTMLDialogElement>(null);
  const [ids, setIds] = useState<string[]>([]),
    [confirm, setConfirm] = useState(false),
    [feedback, setFeedback] = useState(""),
    [failure, setFailure] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (el && typeof el.showModal === "function") el.showModal();
    else el?.setAttribute("open", "");
    return () => {
      el?.close?.();
      if (opener?.isConnected && opener !== document.body)
        opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    void basket.refresh();
  }, [basket.refresh]);
  const inBasket = new Set(basket.items.map((i) => i.id)),
    selected = ids.filter((id) => inBasket.has(id));
  const all =
    basket.items.length > 0 && selected.length === basket.items.length;
  async function act(operation: () => Promise<string>) {
    setFeedback("");
    setFailure(false);
    try {
      setFeedback(await operation());
    } catch (reason) {
      setFeedback(basketError(reason));
      setFailure(true);
    }
  }

  return (
    <dialog
      className="basket-dialog"
      ref={ref}
      aria-label="资料筐"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header className="basket-dialog-heading">
        <span className="basket-heading-icon" aria-hidden="true">
          <ControlIcon name="basket" size={22} />
        </span>
        <div className="basket-heading-text">
          <h2>资料筐</h2>
          {basket.supported && basket.loaded && (
            <small>{basket.items.length} 项资料</small>
          )}
        </div>
        <button
          type="button"
          className="ui-icon-button ui-close"
          aria-label="关闭资料筐"
          title="关闭资料筐"
          onClick={close}
        >
          <ControlIcon name="x" size={18} />
        </button>
      </header>
      <div className="basket-dialog-body">
        <Availability basket={basket} />
        {basket.supported && (
          <>
            <div className="basket-dialog-actions">
              <button
                type="button"
                className="ui-action ui-primary"
                disabled={basket.busy}
                onClick={() =>
                  void act(async () => {
                    const results = await basket.pick();
                    return results.length ? basketResultMessage(results) : "";
                  })
                }
              >
                <ControlIcon name="upload" size={16} />
                添加本地文件
              </button>
              {basket.items.length > 0 && (
                <button
                  type="button"
                  className="ui-action ui-quiet ui-small basket-clear"
                  disabled={basket.busy || confirm}
                  onClick={() => setConfirm(true)}
                >
                  <ControlIcon name="trash" size={14} />
                  清空资料筐
                </button>
              )}
            </div>
            {confirm && (
              <section className="basket-confirm" aria-label="清空资料筐确认">
                <ControlIcon name="trash" size={17} />
                <div className="basket-confirm-content">
                  <strong>
                    清空本机资料筐中的全部 {basket.items.length} 项资料？
                  </strong>
                  <p>已加入工单或会话的材料会保留。</p>
                  <div className="basket-confirm-actions">
                    <button
                      type="button"
                      className="ui-action ui-quiet ui-small"
                      disabled={basket.busy}
                      onClick={() => setConfirm(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="ui-action ui-danger ui-small"
                      disabled={basket.busy}
                      onClick={() =>
                        void act(async () => {
                          await basket.clear();
                          setIds([]);
                          setConfirm(false);
                          return "资料筐已清空";
                        })
                      }
                    >
                      确认清空
                    </button>
                  </div>
                </div>
              </section>
            )}
            {basket.loaded && basket.items.length > 0 && (
              <div className="basket-collection">
                <div
                  className="basket-list-tools"
                  data-selected={selected.length > 0}
                >
                  <SelectAll
                    checked={all}
                    mixed={!all && selected.length > 0}
                    disabled={basket.busy}
                    onChange={() =>
                      setIds(all ? [] : basket.items.map((i) => i.id))
                    }
                  >
                    选择全部
                  </SelectAll>
                  {selected.length > 0 ? (
                    <button
                      type="button"
                      className="ui-action ui-quiet ui-small"
                      disabled={basket.busy}
                      onClick={() =>
                        void act(async () => {
                          await basket.remove(selected);
                          setIds([]);
                          return "已移除 " + selected.length + " 项资料";
                        })
                      }
                    >
                      <ControlIcon name="trash" size={14} />
                      移除所选（{selected.length}）
                    </button>
                  ) : (
                    <span className="basket-size-heading">大小</span>
                  )}
                </div>
                <ul className="basket-manager-list" aria-label="资料列表">
                  {basket.items.map((item) => (
                    <li
                      key={item.id}
                      data-selected={selected.includes(item.id)}
                    >
                      <label className="basket-item">
                        <input
                          type="checkbox"
                          disabled={basket.busy}
                          aria-label={"选择 " + item.displayName}
                          checked={selected.includes(item.id)}
                          onChange={() => setIds(toggle(selected, item.id))}
                        />
                        <ItemName item={item} />
                      </label>
                      <button
                        type="button"
                        className="ui-icon-button basket-remove"
                        title={"移除 " + item.displayName}
                        aria-label={"移除 " + item.displayName}
                        disabled={basket.busy}
                        onClick={() =>
                          void act(async () => {
                            await basket.remove([item.id]);
                            return "已移除 " + item.displayName;
                          })
                        }
                      >
                        <ControlIcon name="x" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {basket.loaded && !basket.items.length && (
              <div className="basket-empty">
                <div className="basket-empty-mark" aria-hidden="true">
                  <ControlIcon name="basket" size={27} />
                </div>
                <strong>资料筐为空</strong>
                <p>可添加本地文件，或从今日、近期和知识库加入资料。</p>
              </div>
            )}
          </>
        )}
        {(basket.busy || feedback) && (
          <div
            className={"basket-feedback" + (failure ? " basket-error" : "")}
            role={failure ? "alert" : "status"}
          >
            {!basket.busy && !failure && <ControlIcon name="check" size={15} />}
            <span>{basket.busy ? "正在更新资料筐…" : feedback}</span>
          </div>
        )}
      </div>
    </dialog>
  );
}

export function AddToBasketButton({
  source,
  label,
  disabled = false,
  className,
  role,
  onResult,
}: {
  source: () => BasketSource | null;
  label: string;
  disabled?: boolean;
  className?: string;
  role?: "menuitem";
  onResult: (message: string) => void;
}) {
  const basket = useMaterialBasket();
  return (
    <button
      type="button"
      role={role}
      disabled={disabled || basket.busy || !basket.supported}
      className={className ?? "ui-action ui-quiet ui-small"}
      title={!basket.supported ? basketUnavailable : undefined}
      onClick={() => {
        const selection = source();
        if (!selection) {
          onResult("此轮的资料标识不可用，请重新查询");
          return;
        }
        void basket
          .add(selection)
          .then((results) => onResult(basketResultMessage(results)))
          .catch((error) => onResult(basketError(error)));
      }}
    >
      <ControlIcon name="basket" size={15} />
      {label}
    </button>
  );
}
