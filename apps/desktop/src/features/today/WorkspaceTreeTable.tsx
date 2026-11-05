import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { FileTypeIcon } from "../../components/FileTypeIcon";
import type {
  QizhiCommands,
  WorkspaceEntry,
  WorkspacePage,
} from "../../lib/tauri";

type TreeRow = WorkspaceEntry & { level: number; parentId: string | null };

function formatTime(epoch: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epoch));
}

function flattenRows(
  entries: WorkspaceEntry[],
  children: Map<string, WorkspaceEntry[]>,
  expanded: Set<string>,
  level = 1,
  parentId: string | null = null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of entries) {
    rows.push({ ...entry, level, parentId });
    if (entry.kind === "directory" && expanded.has(entry.id)) {
      rows.push(
        ...flattenRows(
          children.get(entry.id) ?? [],
          children,
          expanded,
          level + 1,
          entry.id,
        ),
      );
    }
  }
  return rows;
}

function flattenLoadedRows(
  entries: WorkspaceEntry[],
  children: Map<string, WorkspaceEntry[]>,
  level = 1,
  parentId: string | null = null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of entries) {
    rows.push({ ...entry, level, parentId });
    if (entry.kind === "directory") {
      rows.push(
        ...flattenLoadedRows(
          children.get(entry.id) ?? [],
          children,
          level + 1,
          entry.id,
        ),
      );
    }
  }
  return rows;
}

function aggregateValue(
  entry: WorkspaceEntry,
  valueMode: "automatic" | "manual",
) {
  const value = entry.valueSummary;
  if (value.pending === entry.fileCount) {
    return `${value.pending} 项${valueMode === "manual" ? "待手动评估" : "待评估"}`;
  }
  const pieces = [
    value.valuable ? `${value.valuable} 有价值` : "",
    value.notValuable ? `${value.notValuable} 低价值` : "",
    value.pending
      ? `${value.pending} ${valueMode === "manual" ? "待手动评估" : "待评估"}`
      : "",
    value.failed ? `${value.failed} 失败` : "",
    value.unsupported ? `${value.unsupported} 不评估` : "",
  ].filter(Boolean);
  return pieces.join(" · ") || "不评估";
}

const DOCUMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
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

function isDocument(path: string) {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function fileValue(entry: WorkspaceEntry, valueMode: "automatic" | "manual") {
  if (!isDocument(entry.canonicalPath)) {
    return { label: "不评估", className: "status-unsupported" };
  }
  if (entry.valueSummary.valuable) {
    return { label: "有价值", className: "status-valuable" };
  }
  if (entry.valueSummary.notValuable) {
    return { label: "低价值", className: "status-low" };
  }
  if (entry.valueSummary.failed) {
    return { label: "评估失败", className: "status-error" };
  }
  if (entry.valueSummary.unsupported) {
    return { label: "无法解析", className: "status-unsupported" };
  }
  return {
    label: valueMode === "manual" ? "待手动评估" : "评估中",
    className: "status-pending",
  };
}

function SelectionCheckbox({
  label,
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
      onClick={(event) => event.stopPropagation()}
      ref={ref}
      type="checkbox"
    />
  );
}

export function WorkspaceTreeTable({
  commands,
  page,
  selectedFileIds,
  selectedDirectoryIds,
  disabled,
  onFileSelection,
  onDirectorySelection,
  onFileContextMenu,
  onOpenFile,
  onNotice,
  valueMode,
}: {
  commands: QizhiCommands;
  page: WorkspacePage;
  selectedFileIds: Set<number>;
  selectedDirectoryIds: Set<string>;
  disabled: boolean;
  onFileSelection: (id: number, checked: boolean) => void;
  onDirectorySelection: (id: string, checked: boolean) => void;
  onFileContextMenu: (id: number, x: number, y: number) => void;
  onOpenFile: (id: number) => void;
  onNotice: (message: string) => void;
  valueMode: "automatic" | "manual";
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, WorkspaceEntry[]>>(
    new Map(),
  );
  const [nextCursors, setNextCursors] = useState<Map<string, number | null>>(
    new Map(),
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const rows = useMemo(
    () => flattenRows(page.entries, children, expanded),
    [children, expanded, page.entries],
  );
  const allLoadedRows = useMemo(
    () => flattenLoadedRows(page.entries, children),
    [children, page.entries],
  );
  const parentById = useMemo(
    () => new Map(allLoadedRows.map((row) => [row.id, row.parentId])),
    [allLoadedRows],
  );

  function coveredBySelectedDirectory(row: TreeRow) {
    let parent = row.parentId;
    while (parent) {
      if (selectedDirectoryIds.has(parent)) return true;
      parent = parentById.get(parent) ?? null;
    }
    return false;
  }

  function isDescendantOf(row: TreeRow, directoryId: string) {
    let parent = row.parentId;
    while (parent) {
      if (parent === directoryId) return true;
      parent = parentById.get(parent) ?? null;
    }
    return false;
  }

  function hasSelectedDescendant(row: TreeRow) {
    if (row.kind !== "directory") return false;
    return allLoadedRows.some(
      (candidate) =>
        candidate.id !== row.id &&
        isDescendantOf(candidate, row.id) &&
        (candidate.kind === "directory"
          ? selectedDirectoryIds.has(candidate.id)
          : candidate.fileId != null && selectedFileIds.has(candidate.fileId)),
    );
  }

  function selectDirectory(row: TreeRow, checked: boolean) {
    onDirectorySelection(row.id, checked);
    if (!checked) return;
    for (const candidate of allLoadedRows) {
      if (!isDescendantOf(candidate, row.id)) continue;
      if (
        candidate.kind === "directory" &&
        selectedDirectoryIds.has(candidate.id)
      ) {
        onDirectorySelection(candidate.id, false);
      } else if (
        candidate.kind === "file" &&
        candidate.fileId != null &&
        selectedFileIds.has(candidate.fileId)
      ) {
        onFileSelection(candidate.fileId, false);
      }
    }
  }

  useEffect(() => {
    setExpanded(new Set());
    setChildren(new Map());
    setNextCursors(new Map());
    setLoading(new Set());
    setErrors(new Map());
  }, [page.queryId]);

  async function loadDirectory(directoryId: string, cursor = 0) {
    if (!commands.expandTodayWorkspace) return;
    setLoading((current) => new Set(current).add(directoryId));
    setErrors((current) => {
      const next = new Map(current);
      next.delete(directoryId);
      return next;
    });
    try {
      const result = await commands.expandTodayWorkspace(
        page.queryId,
        directoryId,
        cursor,
      );
      setChildren((current) => {
        const next = new Map(current);
        next.set(
          directoryId,
          cursor === 0
            ? result.entries
            : [...(next.get(directoryId) ?? []), ...result.entries],
        );
        return next;
      });
      setNextCursors((current) =>
        new Map(current).set(directoryId, result.nextCursor),
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "无法展开该目录，请重试。";
      setErrors((current) => new Map(current).set(directoryId, message));
    } finally {
      setLoading((current) => {
        const next = new Set(current);
        next.delete(directoryId);
        return next;
      });
    }
  }

  async function toggleDirectory(entry: WorkspaceEntry) {
    if (expanded.has(entry.id)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(entry.id));
    if (!children.has(entry.id)) await loadDirectory(entry.id);
  }

  async function openDirectory(entry: WorkspaceEntry) {
    if (!commands.openTodayWorkspaceDirectory) return;
    try {
      await commands.openTodayWorkspaceDirectory(page.queryId, entry.id);
    } catch {
      onNotice("无法打开该目录，它可能已移动或刚被排除。");
    }
  }

  return (
    <div className="file-table-wrap workspace-tree-wrap">
      <table className="file-table workspace-tree-table">
        <thead>
          <tr>
            <th scope="col" aria-label="选择" />
            <th scope="col">文件或目录</th>
            <th scope="col">修改时间</th>
            <th scope="col">来源</th>
            <th scope="col">
              {valueMode === "automatic" ? "价值评估" : "手动评估"}
            </th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const isDirectory = entry.kind === "directory";
            const fileId = entry.fileId;
            const value = fileValue(entry, valueMode);
            const covered = coveredBySelectedDirectory(entry);
            const directlySelected = isDirectory
              ? selectedDirectoryIds.has(entry.id)
              : fileId != null && selectedFileIds.has(fileId);
            const partiallySelected =
              isDirectory &&
              !covered &&
              !directlySelected &&
              hasSelectedDescendant(entry);
            return (
              <tr
                aria-level={entry.level}
                aria-expanded={isDirectory ? expanded.has(entry.id) : undefined}
                className={isDirectory ? "workspace-directory-row" : undefined}
                key={entry.id}
                onContextMenu={(event) => {
                  if (isDirectory || fileId == null || disabled) return;
                  event.preventDefault();
                  onFileContextMenu(fileId, event.clientX, event.clientY);
                }}
              >
                <td>
                  <SelectionCheckbox
                    label={`选择 ${entry.name}`}
                    checked={covered || directlySelected}
                    indeterminate={partiallySelected}
                    disabled={disabled || covered}
                    onChange={(checked) =>
                      isDirectory
                        ? selectDirectory(entry, checked)
                        : fileId != null
                          ? onFileSelection(fileId, checked)
                          : undefined
                    }
                  />
                </td>
                <td className="file-title" title={entry.canonicalPath}>
                  <div
                    className="workspace-name-cell"
                    style={{ "--tree-level": entry.level } as CSSProperties}
                  >
                    {isDirectory ? (
                      <button
                        aria-label={`${expanded.has(entry.id) ? "收起" : "展开"} ${entry.name}`}
                        className="tree-expander"
                        disabled={loading.has(entry.id)}
                        onClick={() => void toggleDirectory(entry)}
                        type="button"
                      >
                        {loading.has(entry.id)
                          ? "…"
                          : expanded.has(entry.id)
                            ? "⌄"
                            : "›"}
                      </button>
                    ) : (
                      <span className="tree-expander-spacer" />
                    )}
                    {isDirectory ? (
                      <span
                        aria-hidden="true"
                        className="workspace-folder-icon"
                      >
                        ▰
                      </span>
                    ) : (
                      <FileTypeIcon path={entry.canonicalPath} />
                    )}
                    <strong>{entry.name}</strong>
                    {isDirectory ? (
                      <small>{entry.fileCount} 个文件</small>
                    ) : null}
                  </div>
                  {errors.has(entry.id) ? (
                    <button
                      className="tree-inline-error"
                      onClick={() => void loadDirectory(entry.id)}
                      type="button"
                    >
                      {errors.get(entry.id)} 点击重试
                    </button>
                  ) : null}
                </td>
                <td>
                  <time>{formatTime(entry.modifiedAtUtcMs)}</time>
                </td>
                <td className="source-cell">{entry.source}</td>
                <td>
                  {isDirectory ? (
                    <span
                      className="directory-value-summary"
                      title={aggregateValue(entry, valueMode)}
                    >
                      {aggregateValue(entry, valueMode)}
                    </span>
                  ) : (
                    <span className={`value-tag ${value.className}`}>
                      {value.label}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    className="row-open"
                    onClick={() =>
                      isDirectory
                        ? void openDirectory(entry)
                        : fileId != null
                          ? onOpenFile(fileId)
                          : undefined
                    }
                    type="button"
                  >
                    <span>{isDirectory ? "打开目录" : "打开"}</span>
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
                    </svg>
                  </button>
                </td>
              </tr>
            );
          })}
          {[...nextCursors.entries()].map(([directoryId, cursor]) =>
            cursor == null || !expanded.has(directoryId) ? null : (
              <tr className="workspace-load-more" key={`${directoryId}-more`}>
                <td colSpan={6}>
                  <button
                    disabled={loading.has(directoryId)}
                    onClick={() => void loadDirectory(directoryId, cursor)}
                    type="button"
                  >
                    {loading.has(directoryId) ? "正在加载…" : "加载更多"}
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
