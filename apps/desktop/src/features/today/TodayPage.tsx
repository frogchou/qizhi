import { useEffect, useMemo, useRef, useState } from "react";

import { StatusNotice } from "../../components/StatusNotice";
import type {
  QizhiCommands,
  RagflowDataset,
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
function fileCategory(path: string): "documents" | "sourceCode" | null {
  const value = extension(path);
  if (SOURCE_EXTENSIONS.has(value)) return "sourceCode";
  return DOCUMENT_EXTENSIONS.has(value) ? "documents" : null;
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
type UploadDialogState = { fileId: number };

function readableError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    "remediation" in error &&
    typeof error.remediation === "string" &&
    error.remediation.trim()
  ) {
    return error.remediation;
  }
  return fallback;
}

function isExistingScan(message: string) {
  return message.includes("已有今日扫描正在进行");
}

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

const DOCUMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "ods",
  "ppt",
  "pptx",
  "odp",
]);

export function TodayPage({ commands }: { commands: QizhiCommands }) {
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [view, setView] = useState<"today" | "recent">("today");
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
  const [uploadDialog, setUploadDialog] = useState<UploadDialogState | null>(
    null,
  );
  const [datasets, setDatasets] = useState<RagflowDataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [startParsing, setStartParsing] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [followingExistingScan, setFollowingExistingScan] = useState(false);
  const completingExistingScan = useRef(false);

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
    const loadStatus = async () => {
      try {
        const status = await commands.getTodayScanStatus?.();
        if (!active || !status) return;
        setScanStatus(status);
        if (
          followingExistingScan &&
          status.state !== "scanning" &&
          !completingExistingScan.current
        ) {
          completingExistingScan.current = true;
          try {
            setSnapshot(await commands.getTodaySnapshot());
            setNotice(
              status.state === "completed"
                ? "扫描完成，已按当前扫描与排除规则更新列表。"
                : (status.message ??
                    "扫描未完成，请检查扫描范围和文件访问权限。"),
            );
          } catch {
            setNotice("扫描结束后无法读取今日文件。请稍后重新打开今日页面。");
          } finally {
            if (active) {
              setFollowingExistingScan(false);
              setBusy(false);
            }
            completingExistingScan.current = false;
          }
        }
      } catch {
        // The next interval may succeed; the normal refresh error state remains visible.
      }
    };
    void loadStatus();
    const timer = window.setInterval(loadStatus, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [busy, commands, followingExistingScan]);
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [fileMenu]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  async function refresh() {
    setBusy(true);
    setNotice(null);
    setScanStatus(null);
    setFollowingExistingScan(false);
    let followExistingScan = false;
    try {
      setSnapshot(await commands.refreshToday());
    } catch (error) {
      const message = readableError(
        error,
        "刷新未完成，请检查扫描范围和文件访问权限。",
      );
      if (isExistingScan(message)) {
        followExistingScan = true;
        setFollowingExistingScan(true);
        setNotice("另一轮扫描正在进行，完成后将自动更新。");
      } else {
        setNotice(message);
      }
    } finally {
      if (!followExistingScan) setBusy(false);
    }
  }

  async function switchView(next: "today" | "recent") {
    if (next === view) return;
    setView(next);
    setSelected(null);
    if (next === "today") {
      setSnapshot(await commands.getTodaySnapshot());
      return;
    }
    if (!commands.getRecentSnapshot) {
      setNotice("当前桌面服务暂不支持过去文件，请更新栖知后重试。");
      return;
    }
    try {
      setSnapshot(await commands.getRecentSnapshot(5));
    } catch (error) {
      setNotice(readableError(error, "无法读取过去五天的文件。"));
    }
  }

  function scanNotice() {
    if (scanStatus?.state === "scanning") {
      return "正在建立或同步本地 NTFS 索引；不会递归遍历文件夹。";
    }
    if (scanStatus?.state === "failed") {
      return scanStatus.message ?? "扫描未完成，请检查扫描范围和文件访问权限。";
    }
    return "正在准备本地 NTFS 索引；你仍可浏览已发现的文件。";
  }

  const visibleFiles = useMemo(() => {
    if (!snapshot || snapshot.state !== "ready") return [];
    const collator = new Intl.Collator("zh-CN", { sensitivity: "base" });
    const [field, direction] = sort.split("-");
    const factor = direction === "asc" ? 1 : -1;
    return snapshot.files
      .filter((file) => {
        const fileType = fileCategory(file.canonicalPath);
        return (
          fileType !== null && (category === "all" || fileType === category)
        );
      })
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

  async function excludeDirectory(id: number) {
    setFileMenu(null);
    if (!commands.excludeFileDirectory) {
      setNotice("当前桌面服务不支持目录屏蔽，请更新栖知后重试。");
      return;
    }
    try {
      const filtered = await commands.excludeFileDirectory(id);
      setSnapshot(filtered);
      setSelected(null);
      setNotice("已屏蔽该目录；该目录下的文件已从今日列表隐藏。");
    } catch (error) {
      setNotice(readableError(error, "无法屏蔽该目录，请稍后重试。"));
    }
  }

  async function openUploadDialog(id: number) {
    setFileMenu(null);
    setUploadDialog({ fileId: id });
    setDatasetId("");
    setParentPath("");
    setStartParsing(true);
    setUploadError(null);
    setDatasets([]);
    try {
      if (!commands.listRagflowDatasets) {
        throw new Error("当前桌面服务不支持知识库上传。");
      }
      setDatasets(await commands.listRagflowDatasets());
    } catch (error) {
      setUploadError(readableError(error, "无法读取可用知识库。"));
    }
  }

  async function uploadSelectedFile() {
    if (!uploadDialog || !datasetId || uploading) return;
    if (!commands.uploadTodayFile) {
      setUploadError("当前桌面服务不支持知识库上传，请更新栖知后重试。");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const result = await commands.uploadTodayFile({
        fileId: uploadDialog.fileId,
        datasetId,
        parentPath: parentPath.trim() || null,
        startParsing,
      });
      setUploadDialog(null);
      setNotice(
        result.parsingStarted
          ? "文件已上传并开始解析。"
          : result.parsingError
            ? `文件已上传，但未能启动解析：${result.parsingError}`
            : "文件已上传；你可在 RAGFlow 中开始解析。",
      );
    } catch (error) {
      setUploadError(
        readableError(error, "上传失败，请检查知识库连接后重试。"),
      );
    } finally {
      setUploading(false);
    }
  }

  const uploadFile = uploadDialog
    ? (snapshot?.files.find((file) => file.id === uploadDialog.fileId) ?? null)
    : null;

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
          <h1>{view === "today" ? "今天产生的文件" : "过去的工作文件"}</h1>
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
      <div className="workspace-tabs" role="tablist" aria-label="工作文件范围">
        <button
          aria-selected={view === "today"}
          onClick={() => void switchView("today")}
          role="tab"
          type="button"
        >
          今日
        </button>
        <button
          aria-selected={view === "recent"}
          onClick={() => void switchView("recent")}
          role="tab"
          type="button"
        >
          过去
        </button>
      </div>
      {busy ? <div className="workspace-toast">{scanNotice()}</div> : null}
      {notice ? <div className="workspace-toast">{notice}</div> : null}
      <div className="today-layout">
        <div className="file-panel">
          <div className="panel-title">
            <span>{view === "today" ? "今日文件" : "过去 5 天"}</span>
            <span>
              {visibleFiles.length} 项 ·{" "}
              {visibleFiles.filter((file) => file.status === "待分析").length}{" "}
              项评估中
            </span>
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
            <div className="file-table-wrap">
              <table className="file-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <input aria-label="选择全部文件" type="checkbox" />
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        onClick={() =>
                          setSort(
                            sort === "name-asc" ? "name-desc" : "name-asc",
                          )
                        }
                      >
                        文件名
                      </button>
                    </th>
                    <th scope="col">
                      <button
                        type="button"
                        onClick={() =>
                          setSort(
                            sort === "time-desc" ? "time-asc" : "time-desc",
                          )
                        }
                      >
                        创建时间
                      </button>
                    </th>
                    <th scope="col">来源</th>
                    <th scope="col">价值评估</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleFiles.map((file) => (
                    <tr
                      className={selected === file.id ? "selected" : undefined}
                      key={file.id}
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
                      <td>
                        <input
                          aria-label={`选择 ${filename(file.canonicalPath)}`}
                          type="checkbox"
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td
                        className="file-title"
                        title={filename(file.canonicalPath)}
                      >
                        <span className="file-icon">▤</span>
                        <strong>{filename(file.canonicalPath)}</strong>
                      </td>
                      <td>
                        <time>{formatTime(file.modifiedAtUtcMs)}</time>
                      </td>
                      <td className="source-cell">{file.source}</td>
                      <td>
                        <button
                          className="value-tag"
                          type="button"
                          onClick={() => void openUploadDialog(file.id)}
                        >
                          {file.status === "待分析" ? "评估中" : file.status}
                        </button>
                      </td>
                      <td>
                        <button
                          className="row-open"
                          type="button"
                          onClick={() => void fileAction("open", file.id)}
                        >
                          打开
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
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
            role="menuitem"
            onClick={() => void openUploadDialog(fileMenu.id)}
          >
            上传到知识库
          </button>
          <button
            role="menuitem"
            onClick={() => void excludeDirectory(fileMenu.id)}
          >
            屏蔽该目录文件
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
      {uploadDialog ? (
        <div className="upload-modal-backdrop" role="presentation">
          <section
            aria-label="上传到知识库"
            aria-modal="true"
            className="upload-modal"
            role="dialog"
          >
            <header>
              <div>
                <p className="eyebrow">RAGFlow 知识库</p>
                <h2>上传到知识库</h2>
              </div>
              <button
                aria-label="关闭上传对话框"
                className="modal-close"
                disabled={uploading}
                onClick={() => setUploadDialog(null)}
                type="button"
              >
                ×
              </button>
            </header>
            {uploadFile ? (
              <div className="upload-file-summary">
                <strong title={uploadFile.canonicalPath}>
                  {filename(uploadFile.canonicalPath)}
                </strong>
                <span>
                  {formatBytes(uploadFile.sizeBytes)} · 已在本机范围内发现
                </span>
                <small
                  className="upload-file-path"
                  title={uploadFile.canonicalPath}
                >
                  {uploadFile.canonicalPath}
                </small>
              </div>
            ) : (
              <p className="upload-error">所选文件已不在今日列表中。</p>
            )}
            <label className="upload-field">
              <span>目标知识库</span>
              <select
                aria-label="目标知识库"
                disabled={uploading || datasets.length === 0}
                onChange={(event) => setDatasetId(event.currentTarget.value)}
                value={datasetId}
              >
                <option value="">请选择知识库</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="upload-field">
              <span>知识库内目录（可选）</span>
              <input
                aria-label="知识库内目录"
                disabled={uploading}
                onChange={(event) => setParentPath(event.currentTarget.value)}
                placeholder="例如：项目资料/周报"
                value={parentPath}
              />
            </label>
            <label className="upload-checkbox">
              <input
                checked={startParsing}
                disabled={uploading}
                onChange={(event) =>
                  setStartParsing(event.currentTarget.checked)
                }
                type="checkbox"
              />
              上传后立即按知识库现有设置开始解析
            </label>
            {uploadError ? <p className="upload-error">{uploadError}</p> : null}
            <footer>
              <button
                className="button secondary"
                disabled={uploading}
                onClick={() => setUploadDialog(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={!uploadFile || !datasetId || uploading}
                onClick={() => void uploadSelectedFile()}
                type="button"
              >
                {uploading ? "正在上传…" : "上传"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
