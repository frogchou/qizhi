import { useEffect, useMemo, useState } from "react";

import { StatusNotice } from "../../components/StatusNotice";
import type {
  QizhiCommands,
  TodayScanStatus,
  TodaySnapshot,
} from "../../lib/tauri";

function filename(path: string) {
  const parts = path.replace(/\//g, "\\").split("\\");
  return parts[parts.length - 1] ?? path;
}
function formatTime(epoch: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epoch));
}
function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function extension(path: string) {
  const name = filename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
function fileCategory(path: string) {
  const value = extension(path);
  return SOURCE_EXTENSIONS.has(value) ? "sourceCode" : "documents";
}
function wildcardMatches(value: string, query: string) {
  const normalized = query.trim();
  if (!normalized) return true;
  const pattern = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(value);
}

type FileMenu = { id: number; x: number; y: number };

const SOURCE_EXTENSIONS = new Set([
  "rs",
  "py",
  "js",
  "jsx",
  "ts",
  "tsx",
  "java",
  "kt",
  "kts",
  "go",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "cs",
  "php",
  "rb",
  "swift",
  "scala",
  "sql",
  "sh",
  "ps1",
  "r",
  "lua",
  "dart",
  "vue",
  "svelte",
  "css",
  "scss",
  "less",
  "dockerfile",
  "gradle",
  "groovy",
]);

export function TodayPage({ commands }: { commands: QizhiCommands }) {
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<TodayScanStatus | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "documents" | "sourceCode">(
    "all",
  );
  const [sort, setSort] = useState("time-desc");
  const [fileMenu, setFileMenu] = useState<FileMenu | null>(null);

  useEffect(() => {
    commands
      .getTodaySnapshot()
      .then((cachedSnapshot) => {
        setSnapshot(cachedSnapshot);
        void refresh();
      })
      .catch(() =>
        setSnapshot({
          state: "unavailable",
          remediation: "无法读取本地今日记录。",
          files: [],
          clusters: [],
        }),
      );
  }, [commands]);
  useEffect(() => {
    if (!busy || !commands.getTodayScanStatus) return;
    let active = true;
    const loadStatus = () =>
      commands
        .getTodayScanStatus?.()
        .then((status) => active && setScanStatus(status))
        .catch(() => undefined);
    void loadStatus();
    const timer = window.setInterval(loadStatus, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [busy, commands]);
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [fileMenu]);
  async function refresh() {
    setBusy(true);
    setNotice(null);
    setScanStatus(null);
    try {
      setSnapshot(await commands.refreshToday());
    } catch {
      setNotice("刷新未完成，请检查扫描范围和文件访问权限。");
    } finally {
      setBusy(false);
    }
  }

  function scanNotice() {
    if (scanStatus?.state === "scanning") {
      return `正在扫描：已检查 ${scanStatus.directoriesScanned} 个文件夹，发现 ${scanStatus.candidatesFound} 个今日文件。`;
    }
    if (scanStatus?.state === "failed") {
      return scanStatus.message ?? "扫描未完成，请检查扫描范围和文件访问权限。";
    }
    return "正在准备扫描允许目录；你仍可浏览已发现的文件。";
  }

  const visibleFiles = useMemo(() => {
    if (!snapshot || snapshot.state !== "ready") return [];
    const collator = new Intl.Collator("zh-CN", { sensitivity: "base" });
    const [field, direction] = sort.split("-");
    const factor = direction === "asc" ? 1 : -1;
    return snapshot.files
      .filter(
        (file) =>
          category === "all" || fileCategory(file.canonicalPath) === category,
      )
      .filter((file) => wildcardMatches(filename(file.canonicalPath), query))
      .sort((left, right) => {
        if (field === "name") {
          return (
            factor *
            collator.compare(
              filename(left.canonicalPath),
              filename(right.canonicalPath),
            )
          );
        }
        if (field === "type") {
          return (
            factor *
            collator.compare(
              extension(left.canonicalPath),
              extension(right.canonicalPath),
            )
          );
        }
        return factor * (left.modifiedAtUtcMs - right.modifiedAtUtcMs);
      });
  }, [category, query, snapshot, sort]);
  async function locate() {
    if (selected === null) return;
    try {
      await commands.revealInExplorer(selected);
      setNotice("已在资源管理器中定位文件。");
    } catch {
      setNotice("无法定位该文件，它可能已移动或不再允许访问。");
    }
  }

  async function fileAction(
    action: "open" | "text" | "reveal" | "copy" | "delete",
    id: number,
  ) {
    setFileMenu(null);
    try {
      if (action === "open") await commands.openFile(id);
      if (action === "text") await commands.openFileInTextEditor(id);
      if (action === "reveal") await commands.revealInExplorer(id);
      if (action === "copy") await commands.copyFileToClipboard(id);
      if (action === "delete") {
        if (!window.confirm("确定要永久删除这个文件吗？此操作无法撤销。"))
          return;
        await commands.deleteFile(id);
        setSelected(null);
        setSnapshot(await commands.getTodaySnapshot());
      }
      setNotice(
        action === "open"
          ? "已使用系统默认程序打开文件。"
          : action === "text"
            ? "已使用文本编辑器打开文件。"
            : action === "reveal"
              ? "已在资源管理器中定位文件。"
              : action === "copy"
                ? "文件已复制到剪贴板。"
                : "文件已删除。",
      );
    } catch {
      setNotice(
        action === "delete"
          ? "无法删除该文件，它可能已移动、被占用或不再允许访问。"
          : "无法完成文件操作，它可能已移动或不再允许访问。",
      );
    }
  }

  if (!snapshot)
    return (
      <section className="page loading">
        <p>正在读取今日文件…</p>
      </section>
    );
  if (snapshot.state === "unavailable")
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">今日工作空间</p>
            <h1>今天产生的文件</h1>
          </div>
          <button className="button secondary" onClick={refresh}>
            重新检测
          </button>
        </header>
        <StatusNotice>{snapshot.remediation}</StatusNotice>
      </section>
    );
  return (
    <section className="page today-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">今日工作空间</p>
          <h1>今天产生的文件</h1>
          <p className="muted">按修改时间发现，内容尚未分析。</p>
        </div>
        <div className="header-actions">
          <button
            className="button secondary"
            onClick={refresh}
            disabled={busy}
          >
            {busy ? "刷新中…" : "刷新列表"}
          </button>
          <button className="button primary" disabled>
            生成今日总结
          </button>
        </div>
      </header>
      {busy ? <StatusNotice>{scanNotice()}</StatusNotice> : null}
      {notice ? <StatusNotice>{notice}</StatusNotice> : null}
      <div className="today-layout">
        <div className="file-panel">
          <div className="panel-title">
            <span>文件</span>
            <span>{visibleFiles.length} 项</span>
          </div>
          <div className="file-controls" aria-label="今日文件筛选与排序">
            <input
              aria-label="按文件名搜索"
              value={query}
              placeholder="搜索文件名，支持 * 和 ?"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <select
              aria-label="文件类型筛选"
              value={category}
              onChange={(event) =>
                setCategory(
                  event.currentTarget.value as
                    "all" | "documents" | "sourceCode",
                )
              }
            >
              <option value="all">所有支持类型</option>
              <option value="documents">文档与文本</option>
              <option value="sourceCode">源代码</option>
            </select>
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => setSort(event.currentTarget.value)}
            >
              <option value="time-desc">时间：最新优先</option>
              <option value="time-asc">时间：最早优先</option>
              <option value="name-asc">名称：A → Z</option>
              <option value="name-desc">名称：Z → A</option>
              <option value="type-asc">类型：A → Z</option>
              <option value="type-desc">类型：Z → A</option>
            </select>
          </div>
          {visibleFiles.length === 0 ? (
            <p className="empty">今天的扫描范围内还没有发现新文件。</p>
          ) : (
            <ul className="file-list">
              {visibleFiles.map((file) => (
                <li key={file.id}>
                  <button
                    className={
                      selected === file.id ? "file-row selected" : "file-row"
                    }
                    onClick={() => setSelected(file.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelected(file.id);
                      setFileMenu({
                        id: file.id,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    <span className="file-icon">▤</span>
                    <span className="file-name">
                      <strong>{filename(file.canonicalPath)}</strong>
                      <small>
                        {file.source} · {formatBytes(file.sizeBytes)}
                      </small>
                    </span>
                    <time>{formatTime(file.modifiedAtUtcMs)}</time>
                    <span className="tag">{file.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className="detail-panel">
          <p className="eyebrow">选择文件</p>
          <h2>
            {selected === null
              ? "查看文件上下文"
              : filename(
                  snapshot.files.find((file) => file.id === selected)
                    ?.canonicalPath ?? "",
                )}
          </h2>
          <p className="muted">
            本版本只记录安全的文件元信息，不读取或上传内容。
          </p>
          <button
            className="button secondary full"
            disabled={selected === null}
            onClick={locate}
          >
            在资源管理器中定位
          </button>
          <button className="button outline full" disabled>
            加入知识库（后续版本）
          </button>
        </aside>
      </div>
      <section className="timeline">
        <h2>今日活动</h2>
        {snapshot.clusters.map((cluster) => (
          <div className="timeline-item" key={cluster.label}>
            <span className="timeline-dot" />
            <div>
              <strong>{cluster.label}</strong>
              <p>{cluster.fileIds.length} 个文件 · 待分析</p>
            </div>
          </div>
        ))}
      </section>
      {fileMenu ? (
        <div
          className="file-context-menu"
          role="menu"
          style={{ left: fileMenu.x, top: fileMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => void fileAction("open", fileMenu.id)}
          >
            打开文件
          </button>
          <button
            role="menuitem"
            onClick={() => void fileAction("text", fileMenu.id)}
          >
            使用文本编辑器打开
          </button>
          <button
            role="menuitem"
            onClick={() => void fileAction("reveal", fileMenu.id)}
          >
            打开文件所在位置
          </button>
          <button
            role="menuitem"
            onClick={() => void fileAction("copy", fileMenu.id)}
          >
            复制文件
          </button>
          <button
            className="danger"
            role="menuitem"
            onClick={() => void fileAction("delete", fileMenu.id)}
          >
            删除文件
          </button>
        </div>
      ) : null}
    </section>
  );
}
