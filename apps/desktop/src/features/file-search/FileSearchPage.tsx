import { useEffect, useRef, useState } from "react";
import { ControlIcon } from "../../components/ControlIcon";
import { useFeedback } from "../../components/FeedbackNotice";
import type {
  FileSearchAction,
  FileSearchPageData,
  FileSearchResult,
  QizhiCommands,
} from "../../lib/tauri";
import { useMaterialBasket } from "../materials/MaterialBasket";
import { basketSize } from "../materials/basket-types";
import "./file-search.css";

const SEARCH_DELAY = 45;
const INDEX_POLL_DELAY = 1100;
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
});
const states = {
  ready: "已就绪",
  building: "正在建立索引",
  partial: "部分内容无法访问",
  unavailable: "无法访问",
  retrying: "更新失败，正在重试",
};
const coveragePriority = {
  ready: 0,
  partial: 1,
  building: 2,
  retrying: 3,
  unavailable: 4,
};

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : fallback;
}

function samePage(
  prior: FileSearchPageData | null,
  current: FileSearchPageData,
) {
  return (
    !!prior &&
    prior.nextCursor === current.nextCursor &&
    prior.files.length === current.files.length &&
    prior.coverage.length === current.coverage.length &&
    prior.coverage.every(
      (root, index) =>
        root.path === current.coverage[index].path &&
        root.state === current.coverage[index].state,
    ) &&
    prior.files.every((file, index) => {
      const other = current.files[index];
      return (
        file.recordKey === other.recordKey &&
        file.sizeBytes === other.sizeBytes &&
        file.modifiedAtUtcMs === other.modifiedAtUtcMs
      );
    })
  );
}

function appendPage(current: FileSearchPageData, next: FileSearchPageData) {
  const existing = new Set(current.files.map((file) => file.recordKey));
  const priorCoverage = new Map(
    current.coverage.map((root) => [root.path, root]),
  );
  return {
    ...next,
    files: [
      ...current.files,
      ...next.files.filter((file) => !existing.has(file.recordKey)),
    ],
    coverage: next.coverage.map((root) => {
      const prior = priorCoverage.get(root.path);
      return prior &&
        coveragePriority[prior.state] > coveragePriority[root.state]
        ? prior
        : root;
    }),
  };
}

export function FileSearchPage({ commands }: { commands: QizhiCommands }) {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState<FileSearchPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const intent = useRef(0);
  const shown = useRef<FileSearchPageData | null>(null);
  const requestedPages = useRef(1);
  const loadingMore = useRef(false);
  const notify = useFeedback("success");
  const basket = useMaterialBasket();
  const { searchLocalFiles, actOnSearchResult } = commands;
  const query = keyword.trim();

  useEffect(() => {
    if (!searchLocalFiles) return;
    let active = true;
    let timer: number;
    const request = intent.current;
    async function search() {
      const pages = requestedPages.current;
      const isCurrent = () =>
        active &&
        request === intent.current &&
        !loadingMore.current &&
        pages === requestedPages.current;
      try {
        if (!isCurrent()) return;
        let result = await searchLocalFiles?.({ query, cursor: null });
        if (!isCurrent() || !result) return;
        for (
          let pageNumber = 1;
          pageNumber < pages && result.nextCursor;
          pageNumber++
        ) {
          const next = await searchLocalFiles?.({
            query,
            cursor: result.nextCursor,
          });
          if (!isCurrent() || !next) return;
          result = appendPage(result, next);
        }
        if (!samePage(shown.current, result)) {
          shown.current = result;
          setPage(result);
        }
        setError(null);
      } catch (reason) {
        if (!isCurrent()) return;
        shown.current = null;
        setPage(null);
        setError(errorMessage(reason, "无法查找文件，请重试。"));
      } finally {
        if (active && request === intent.current)
          timer = window.setTimeout(() => void search(), INDEX_POLL_DELAY);
      }
    }
    timer = window.setTimeout(() => void search(), query ? SEARCH_DELAY : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, searchLocalFiles]);

  function updateKeyword(value: string) {
    if (value.trim() !== query) {
      intent.current += 1;
      shown.current = null;
      requestedPages.current = 1;
      loadingMore.current = false;
      setPage(null);
      setError(null);
      setPaging(false);
    }
    setKeyword(value);
  }

  async function loadMore() {
    const start = shown.current;
    if (!start?.nextCursor || !searchLocalFiles || loadingMore.current) return;
    const request = intent.current;
    loadingMore.current = true;
    setPaging(true);
    try {
      const next = await searchLocalFiles({ query, cursor: start.nextCursor });
      if (request !== intent.current || start !== shown.current) return;
      requestedPages.current += 1;
      shown.current = appendPage(start, next);
      setPage(shown.current);
    } catch (reason) {
      if (request === intent.current)
        notify(errorMessage(reason, "无法加载更多结果，请重试。"), "error");
    } finally {
      if (request === intent.current) {
        loadingMore.current = false;
        setPaging(false);
      }
    }
  }

  async function act(file: FileSearchResult, action: FileSearchAction) {
    if (!actOnSearchResult || acting) return;
    setActing(file.recordKey);
    try {
      await actOnSearchResult(file.recordKey, action);
      if (action === "addToBasket") {
        notify("已加入资料筐。");
        void basket.refresh().catch(() => undefined);
      } else if (action === "copy") {
        notify("文件已复制到剪贴板。");
      }
    } catch (reason) {
      notify(errorMessage(reason, "无法完成文件操作，请重新查找。"), "error");
    } finally {
      setActing(null);
    }
  }

  const coverage = page?.coverage ?? [];
  const ready = coverage.filter((root) => root.state === "ready").length;
  return (
    <section
      className="page file-search-page"
      aria-labelledby="file-search-title"
    >
      <header className="page-header">
        <h1 id="file-search-title">快速查找</h1>
      </header>
      <div className="file-search-input">
        <ControlIcon name="search" size={18} />
        <input
          type="search"
          maxLength={256}
          value={keyword}
          placeholder="输入文件名、扩展名或路径片段"
          aria-label="查找文件名或路径"
          onChange={(event) => updateKeyword(event.currentTarget.value)}
        />
      </div>
      {coverage.length > 0 && (
        <details className="file-search-coverage">
          <summary>
            {ready} / {coverage.length} 个工作目录已就绪
          </summary>
          <ul>
            {coverage.map((root) => (
              <li key={root.path}>
                <span>{root.path}</span>
                <strong>{states[root.state]}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="file-search-status" role="alert">
          {error}
        </p>
      )}
      {page && !coverage.length && (
        <p className="file-search-status">
          请先在设置中添加允许扫描的本机工作文件夹。
        </p>
      )}
      {page && coverage.length > 0 && ready < coverage.length && (
        <p className="file-search-status">
          部分目录还在更新或无法访问。可展开工作目录查看状态。
        </p>
      )}
      {!searchLocalFiles && (
        <p className="file-search-status">当前设备暂不支持快速查找。</p>
      )}
      {query && (
        <div aria-live="polite" className="file-search-results">
          {page === null && !error && searchLocalFiles && (
            <p className="file-search-status">正在查找…</p>
          )}
          {page && !!coverage.length && page.files.length === 0 && (
            <p className="file-search-status">已就绪的目录中没有匹配文件。</p>
          )}
          {page && page.files.length > 0 && (
            <table className="file-search-table" aria-label="查找结果">
              <thead>
                <tr>
                  <th>文件名和路径</th>
                  <th>修改时间</th>
                  <th>大小</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {page.files.map((file) => (
                  <tr key={file.recordKey}>
                    <td>
                      <button
                        type="button"
                        className="file-search-filename"
                        title={file.name}
                        disabled={!!acting}
                        onClick={() => void act(file, "open")}
                      >
                        {file.name}
                      </button>
                      <span className="file-search-path" title={file.path}>
                        {file.path}
                      </span>
                    </td>
                    <td>
                      {file.modifiedAtUtcMs > 0
                        ? dateFormat.format(file.modifiedAtUtcMs)
                        : "—"}
                    </td>
                    <td>{basketSize(file.sizeBytes)}</td>
                    <td>
                      <div className="file-search-actions">
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!!acting}
                          aria-label={`在 Finder 定位 ${file.name}`}
                          onClick={() => void act(file, "reveal")}
                        >
                          定位
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!!acting}
                          aria-label={`复制 ${file.name}`}
                          onClick={() => void act(file, "copy")}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!!acting}
                          aria-label={`加入资料筐 ${file.name}`}
                          onClick={() => void act(file, "addToBasket")}
                        >
                          加入资料筐
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {page?.nextCursor && (
        <button
          type="button"
          className="button secondary file-search-more"
          disabled={paging}
          onClick={() => void loadMore()}
        >
          {paging ? "正在加载…" : "加载更多"}
        </button>
      )}
    </section>
  );
}
