import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { FileTypeIcon } from "../../components/FileTypeIcon";
import { StatusNotice } from "../../components/StatusNotice";
import type {
  CodexHandoffResult,
  CodexHandoffSourceInput,
  QizhiCommands,
  RagflowDataset,
  SummaryPromptTemplate,
  TodayFile,
  TodayScanStatus,
  TodaySnapshot,
  WorkspaceQueryInput,
  WorkspacePage,
  WorkSummaryPreparation,
  WorkSummarySelectionInput,
  WorkSummary,
  WorkSummaryStreamEvent,
} from "../../lib/tauri";
import { CodexDestinationDialog } from "../codex/CodexDestinationDialog";
import {
  SummaryResultDialog,
  type SummaryDialogState,
} from "./SummaryResultDialog";
import { WorkspaceTreeTable } from "./WorkspaceTreeTable";

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
function valueStatusClass(status: TodayFile["status"]) {
  if (status === "待分析") return "status-pending";
  if (status === "有价值") return "status-valuable";
  if (status === "低价值") return "status-low";
  if (status === "无法解析") return "status-unsupported";
  return "status-error";
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
type WorkspaceView = "today" | "recent";

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
  return (
    message.includes("已有今日扫描正在进行") ||
    message.includes("本地索引服务正在处理另一项索引任务")
  );
}

function workspaceQueryInput(
  scope: WorkspaceView,
  category: "all" | "documents" | "sourceCode",
  search: string,
  sort: string,
): WorkspaceQueryInput {
  return {
    scope,
    days: scope === "recent" ? 5 : null,
    category,
    search,
    sort: sort.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    ) as WorkspaceQueryInput["sort"],
  };
}

const SOURCE_EXTENSIONS = new Set([
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
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

export function TodayPage({
  commands,
  onOpenCodex,
}: {
  commands: QizhiCommands;
  onOpenCodex?: (result: CodexHandoffResult) => void;
}) {
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [view, setView] = useState<WorkspaceView>("today");
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(
    new Set(),
  );
  const [selectedDirectoryIds, setSelectedDirectoryIds] = useState<Set<string>>(
    new Set(),
  );
  const [workspacePage, setWorkspacePage] = useState<WorkspacePage | null>(
    null,
  );
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [summaryTemplates, setSummaryTemplates] = useState<
    SummaryPromptTemplate[]
  >([]);
  const [summaryMenuOpen, setSummaryMenuOpen] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [manualEvaluationBusy, setManualEvaluationBusy] = useState(false);
  const [summaryResult, setSummaryResult] = useState<SummaryDialogState | null>(
    null,
  );
  const [summaryConfirmation, setSummaryConfirmation] = useState<{
    template: SummaryPromptTemplate;
    preparation: WorkSummaryPreparation;
    selection: WorkSummarySelectionInput;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<TodayScanStatus | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "documents" | "sourceCode">(
    "documents",
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
  const [codexHandoff, setCodexHandoff] = useState<{
    source: CodexHandoffSourceInput;
    fileIds: number[];
    directoryIds: string[];
  } | null>(null);
  const [followingExistingScan, setFollowingExistingScan] = useState(false);
  const completingExistingScan = useRef(false);
  const viewRef = useRef<WorkspaceView>("today");
  const evaluatingIds = useRef(new Set<number>());
  const contextMenuRef = useRef<HTMLDivElement>(null);

  function openCodexHandoff(fileId?: number) {
    if (!workspacePage) {
      setNotice("当前目录查询尚未准备好，请刷新列表后重试。");
      return;
    }
    const fileIds = fileId == null ? [...selectedFileIds] : [fileId];
    const directoryIds = fileId == null ? [...selectedDirectoryIds] : [];
    if (fileIds.length === 0 && directoryIds.length === 0) return;
    setFileMenu(null);
    setCodexHandoff({
      source: {
        kind: view,
        queryId: workspacePage.queryId,
        fileIds,
        directoryIds,
      },
      fileIds,
      directoryIds,
    });
  }

  function finishCodexHandoff(result: CodexHandoffResult) {
    const sent = codexHandoff;
    if (!sent) return;
    setSelectedFileIds((current) => {
      const next = new Set(current);
      for (const id of sent.fileIds) next.delete(id);
      return next;
    });
    setSelectedDirectoryIds((current) => {
      const next = new Set(current);
      for (const id of sent.directoryIds) next.delete(id);
      return next;
    });
    setCodexHandoff(null);
    onOpenCodex?.(result);
  }

  useEffect(() => {
    commands
      .getTodaySnapshot()
      .then((cachedSnapshot) => {
        if (viewRef.current === "today") setSnapshot(cachedSnapshot);
        void refresh("today");
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
    commands
      .getSummarySettings?.()
      .then((settings) => setSummaryTemplates(settings.templates))
      .catch(() => undefined);
  }, [commands]);
  useEffect(() => {
    if (!snapshot || snapshot.state !== "ready") return;
    const existing = new Set(snapshot.files.map((file) => file.id));
    setSelectedFileIds(
      (current) => new Set([...current].filter((id) => existing.has(id))),
    );
  }, [snapshot]);
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
            const completedSnapshot =
              viewRef.current === "recent" && commands.getRecentSnapshot
                ? await commands.getRecentSnapshot(5)
                : await commands.getTodaySnapshot();
            setSnapshot(completedSnapshot);
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
  useLayoutEffect(() => {
    if (!fileMenu || !contextMenuRef.current) return;
    const bounds = contextMenuRef.current.getBoundingClientRect();
    const edge = 8;
    const x = Math.max(
      edge,
      Math.min(fileMenu.x, window.innerWidth - bounds.width - edge),
    );
    const y = Math.max(
      edge,
      Math.min(fileMenu.y, window.innerHeight - bounds.height - edge),
    );
    if (x !== fileMenu.x || y !== fileMenu.y) {
      setFileMenu((current) => (current ? { ...current, x, y } : current));
    }
  }, [fileMenu]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (
      commands.queryTodayWorkspace ||
      view !== "today" ||
      !commands.evaluateTodayFiles ||
      !snapshot ||
      snapshot.state !== "ready"
    ) {
      return;
    }
    const fileIds = snapshot.files
      .filter(
        (file) =>
          file.status === "待分析" &&
          fileCategory(file.canonicalPath) === "documents" &&
          !evaluatingIds.current.has(file.id),
      )
      .map((file) => file.id);
    if (fileIds.length === 0) return;
    fileIds.forEach((id) => evaluatingIds.current.add(id));
    let active = true;
    commands
      .evaluateTodayFiles(fileIds)
      .then((results) => {
        if (!active) return;
        const byId = new Map(results.map((result) => [result.fileId, result]));
        setSnapshot((current) =>
          current?.state === "ready"
            ? {
                ...current,
                files: current.files.map((file) => {
                  const result = byId.get(file.id);
                  return result
                    ? { ...file, status: result.status, score: result.score }
                    : file;
                }),
              }
            : current,
        );
      })
      .catch((error) => {
        if (!active) return;
        setSnapshot((current) =>
          current?.state === "ready"
            ? {
                ...current,
                files: current.files.map((file) =>
                  fileIds.includes(file.id)
                    ? { ...file, status: "评估失败" as const }
                    : file,
                ),
              }
            : current,
        );
        setNotice(readableError(error, "JEV 价值评估失败，请检查设置和日志。"));
      })
      .finally(() => {
        fileIds.forEach((id) => evaluatingIds.current.delete(id));
      });
    return () => {
      active = false;
    };
  }, [commands, snapshot, view]);

  useEffect(() => {
    if (
      !commands.queryTodayWorkspace ||
      !snapshot ||
      snapshot.state !== "ready"
    ) {
      return;
    }
    setWorkspaceLoading(true);
    setWorkspacePage(null);
    setSelectedFileIds(new Set());
    setSelectedDirectoryIds(new Set());
    let active = true;
    const timer = window.setTimeout(async () => {
      setWorkspaceLoading(true);
      setSelectedFileIds(new Set());
      setSelectedDirectoryIds(new Set());
      try {
        const input = workspaceQueryInput(view, category, query, sort);
        const page = await commands.queryTodayWorkspace?.(input);
        if (!active || !page) return;
        setWorkspacePage(page);
        if (view === "today" && commands.evaluateWorkspaceQuery) {
          try {
            const evaluation = await commands.evaluateWorkspaceQuery(
              page.queryId,
              "today",
            );
            if (evaluation?.failed) {
              setNotice(
                evaluation.failureMessage ??
                  `${evaluation.failed} 个文件的 JEV 价值评估失败，请检查设置和日志。`,
              );
            }
            const refreshed = await commands.queryTodayWorkspace?.(input);
            if (active && refreshed) setWorkspacePage(refreshed);
          } catch (error) {
            if (active) {
              setNotice(
                readableError(error, "JEV 价值评估失败，请检查设置和日志。"),
              );
            }
          }
        }
      } catch (error) {
        if (active) {
          setWorkspacePage(null);
          setNotice(readableError(error, "无法整理工作文件目录。"));
        }
      } finally {
        if (active) setWorkspaceLoading(false);
      }
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [category, commands, query, snapshot, sort, view]);

  async function refresh(target = viewRef.current) {
    setBusy(true);
    setNotice(null);
    setScanStatus(null);
    setFollowingExistingScan(false);
    let followExistingScan = false;
    try {
      if (target === "recent") {
        if (!commands.getRecentSnapshot) {
          throw new Error("当前桌面服务暂不支持过去文件，请更新栖知后重试。");
        }
        const recentSnapshot = await commands.getRecentSnapshot(5);
        if (viewRef.current === target) setSnapshot(recentSnapshot);
      } else {
        const todaySnapshot = await commands.refreshToday();
        if (viewRef.current === target) setSnapshot(todaySnapshot);
      }
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

  async function switchView(next: WorkspaceView) {
    if (next === view) return;
    viewRef.current = next;
    setView(next);
    setSelected(null);
    setSelectedFileIds(new Set());
    setSelectedDirectoryIds(new Set());
    setWorkspacePage(null);
    if (next === "today") {
      const todaySnapshot = await commands.getTodaySnapshot();
      if (viewRef.current === next) setSnapshot(todaySnapshot);
      return;
    }
    if (!commands.getRecentSnapshot) {
      setNotice("当前桌面服务暂不支持过去文件，请更新栖知后重试。");
      return;
    }
    await refresh(next);
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

  const allVisibleSelected =
    visibleFiles.length > 0 &&
    visibleFiles.every((file) => selectedFileIds.has(file.id));
  const defaultSummaryTemplate =
    summaryTemplates.find((template) => template.isDefault) ??
    summaryTemplates[0];

  function toggleVisibleSelection(checked: boolean) {
    if (summaryBusy || manualEvaluationBusy) return;
    setSelectedFileIds((current) => {
      const next = new Set(current);
      visibleFiles.forEach((file) =>
        checked ? next.add(file.id) : next.delete(file.id),
      );
      return next;
    });
  }

  function clearWorkspaceSelections() {
    if (!commands.queryTodayWorkspace) return;
    setSelectedFileIds(new Set());
    setSelectedDirectoryIds(new Set());
    setWorkspacePage(null);
    setWorkspaceLoading(true);
  }

  async function manuallyEvaluateSelectedFiles() {
    if (view !== "recent" || manualEvaluationBusy) return;
    if (!commands.evaluateTodayFiles) {
      setNotice("当前桌面服务不支持手动价值评估，请更新栖知后重试。");
      return;
    }
    let fileIds = [...selectedFileIds];
    if (workspacePage && commands.resolveTodayWorkspaceSelection) {
      try {
        const resolved = await commands.resolveTodayWorkspaceSelection({
          queryId: workspacePage.queryId,
          fileIds,
          directoryIds: [...selectedDirectoryIds],
        });
        fileIds = resolved.fileIds;
      } catch (error) {
        setNotice(readableError(error, "无法读取所选文件，请刷新列表后重试。"));
        return;
      }
    }
    if (fileIds.length === 0) {
      setNotice("请先勾选需要评估的文档或目录。");
      return;
    }
    setManualEvaluationBusy(true);
    try {
      const results = await commands.evaluateTodayFiles(fileIds);
      const byId = new Map(results.map((result) => [result.fileId, result]));
      if (!workspacePage) {
        setSnapshot((current) =>
          current?.state === "ready"
            ? {
                ...current,
                files: current.files.map((file) => {
                  const result = byId.get(file.id);
                  return result
                    ? { ...file, status: result.status, score: result.score }
                    : file;
                }),
              }
            : current,
        );
      }
      if (workspacePage && commands.queryTodayWorkspace) {
        const page = await commands.queryTodayWorkspace(
          workspaceQueryInput(view, category, query, sort),
        );
        setWorkspacePage(page);
      }
      const failures = results.filter((result) => result.status === "评估失败");
      setNotice(
        failures.length > 0
          ? `${failures.length} 个文件评估失败；相同版本不会自动重复请求。`
          : `已完成 ${results.length} 个所选文件的价值评估。`,
      );
    } catch (error) {
      setNotice(readableError(error, "JEV 价值评估失败，请检查设置和日志。"));
    } finally {
      setManualEvaluationBusy(false);
    }
  }

  async function generateSummary(
    template: SummaryPromptTemplate | undefined,
    confirmedMultiBatch = false,
    frozenSelection?: WorkSummarySelectionInput,
  ) {
    setSummaryMenuOpen(false);
    const selectionInput = frozenSelection ?? {
      queryId: workspacePage?.queryId ?? null,
      fileIds: [...selectedFileIds],
      directoryIds: [...selectedDirectoryIds],
    };
    const hasSelection =
      selectionInput.fileIds.length > 0 ||
      selectionInput.directoryIds.length > 0;
    if (!template || !commands.generateWorkSummary || !hasSelection) {
      setNotice(
        !hasSelection
          ? "请先勾选需要总结的文件。"
          : "总结设置尚未就绪，请在设置中保存总结模板。",
      );
      return;
    }
    let fileIds = [...selectionInput.fileIds];
    setSummaryBusy(true);
    setSummaryResult({
      status: "generating",
      markdown: "",
      truncated: false,
      fileCount: fileIds.length + selectionInput.directoryIds.length,
      templateTitle: template.title,
      error: null,
      batchProgress: null,
    });
    if (commands.prepareWorkSummary) {
      try {
        const prepared = await commands.prepareWorkSummary(selectionInput);
        setSummaryResult((current) =>
          current ? { ...current, fileCount: prepared.fileCount } : current,
        );
        if (prepared.requiresConfirmation && !confirmedMultiBatch) {
          setSummaryResult(null);
          setSummaryConfirmation({
            template,
            preparation: prepared,
            selection: selectionInput,
          });
          setSummaryBusy(false);
          return;
        }
      } catch (error) {
        setSummaryResult(null);
        setSummaryBusy(false);
        setNotice(readableError(error, "无法核对所选文件，请刷新列表后重试。"));
        return;
      }
    } else if (workspacePage && commands.resolveTodayWorkspaceSelection) {
      try {
        const resolved = await commands.resolveTodayWorkspaceSelection({
          queryId: workspacePage.queryId,
          fileIds,
          directoryIds: [...selectedDirectoryIds],
        });
        fileIds = resolved.fileIds;
        setSummaryResult((current) =>
          current ? { ...current, fileCount: resolved.fileCount } : current,
        );
      } catch (error) {
        setSummaryResult(null);
        setSummaryBusy(false);
        setNotice(readableError(error, "无法核对所选文件，请刷新列表后重试。"));
        return;
      }
    }
    if (!commands.prepareWorkSummary && fileIds.length === 0) {
      setSummaryResult(null);
      setSummaryBusy(false);
      setNotice("所选目录中没有仍可访问的文件。");
      return;
    }
    const updateFromEvent = (event: WorkSummaryStreamEvent) => {
      setSummaryResult((current) => {
        if (!current) return null;
        if (event.kind === "started") {
          return {
            ...current,
            templateTitle: event.templateTitle,
            fileCount: event.fileCount,
          };
        }
        if (event.kind === "delta") {
          return { ...current, markdown: current.markdown + event.delta };
        }
        if (event.kind === "batchProgress") {
          return {
            ...current,
            batchProgress: {
              current: event.current,
              total: event.total,
              phase: event.phase,
            },
          };
        }
        return { ...current, truncated: event.truncated };
      });
    };
    try {
      const result: WorkSummary = await commands.generateWorkSummary(
        selectionInput.queryId
          ? {
              queryId: selectionInput.queryId,
              fileIds,
              directoryIds: selectionInput.directoryIds,
              templateId: template.id,
              confirmedMultiBatch,
            }
          : { fileIds, templateId: template.id },
        updateFromEvent,
      );
      setSummaryResult((current) =>
        current ? { ...result, status: "completed", error: null } : current,
      );
    } catch (error) {
      const message = readableError(
        error,
        "生成总结失败，请检查 OpenAI 设置和所选文件。",
      );
      setSummaryResult((current) =>
        current ? { ...current, status: "failed", error: message } : current,
      );
    } finally {
      setSummaryBusy(false);
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
            <h1>今天有变动的文件</h1>
          </div>
          <button className="button secondary" onClick={() => void refresh()}>
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
          <h1>{view === "today" ? "今天有变动的文件" : "过去的工作文件"}</h1>
          <p className="muted">
            {view === "today"
              ? "基于 NTFS 变更记录发现今天新建或修改的文件，内容尚未分析。"
              : "按修改时间发现，内容尚未分析。"}
          </p>
        </div>
        <div className="header-actions">
          <button
            className="button secondary send-codex-action"
            disabled={
              summaryBusy ||
              manualEvaluationBusy ||
              !workspacePage ||
              (selectedFileIds.size === 0 && selectedDirectoryIds.size === 0)
            }
            onClick={() => openCodexHandoff()}
            type="button"
          >
            发送到 Codex
          </button>
          <button
            className="button secondary"
            onClick={() => void refresh()}
            disabled={busy || summaryBusy || manualEvaluationBusy}
          >
            {busy ? "刷新中…" : "刷新列表"}
          </button>
          <div className="summary-action">
            <div
              aria-label="今日总结操作"
              className="summary-split-button"
              role="group"
            >
              <button
                className="button primary summary-primary-action"
                disabled={
                  summaryBusy ||
                  (selectedFileIds.size === 0 &&
                    selectedDirectoryIds.size === 0) ||
                  !defaultSummaryTemplate
                }
                onClick={() => void generateSummary(defaultSummaryTemplate)}
                type="button"
              >
                {summaryBusy ? "正在总结…" : "生成今日总结"}
              </button>
              <button
                aria-label="选择总结方式"
                className="button primary summary-menu-trigger"
                disabled={
                  summaryBusy ||
                  (selectedFileIds.size === 0 &&
                    selectedDirectoryIds.size === 0) ||
                  summaryTemplates.length === 0
                }
                onClick={() => setSummaryMenuOpen((open) => !open)}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 18 18">
                  <path d="m4.5 6.75 4.5 4.5 4.5-4.5" />
                </svg>
              </button>
            </div>
            {summaryMenuOpen ? (
              <div className="summary-template-menu" role="menu">
                {summaryTemplates.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => void generateSummary(template)}
                    role="menuitem"
                    type="button"
                  >
                    <strong>{template.title}</strong>
                    {template.isDefault ? <span>默认</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="工作文件范围">
        <button
          aria-selected={view === "today"}
          disabled={summaryBusy || manualEvaluationBusy}
          onClick={() => void switchView("today")}
          role="tab"
          type="button"
        >
          今日
        </button>
        <button
          aria-selected={view === "recent"}
          disabled={summaryBusy || manualEvaluationBusy}
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
            <span>{view === "today" ? "今日变动" : "过去 5 天"}</span>
            <span>
              {workspacePage?.totalFileCount ?? visibleFiles.length} 个文件 ·{" "}
              {view === "today"
                ? `${
                    workspacePage
                      ? workspacePage.entries.reduce(
                          (total, entry) => total + entry.valueSummary.pending,
                          0,
                        )
                      : visibleFiles.filter(
                          (file) =>
                            file.status === "待分析" &&
                            fileCategory(file.canonicalPath) === "documents",
                        ).length
                  } 项评估中 · `
                : "仅手动评估 · "}
              已选 {selectedFileIds.size + selectedDirectoryIds.size} 项
            </span>
          </div>
          <div className="file-controls" aria-label="今日文件筛选与排序">
            <input
              aria-label="按文件名搜索"
              value={query}
              placeholder="搜索文件名，支持 * 和 ?"
              onChange={(event) => {
                clearWorkspaceSelections();
                setQuery(event.currentTarget.value);
              }}
            />
            <select
              aria-label="文件类型筛选"
              value={category}
              onChange={(event) => {
                clearWorkspaceSelections();
                setCategory(
                  event.currentTarget.value as
                    "all" | "documents" | "sourceCode",
                );
              }}
            >
              <option value="all">所有支持类型</option>
              <option value="documents">文档与文本</option>
              <option value="sourceCode">源代码</option>
            </select>
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => {
                clearWorkspaceSelections();
                setSort(event.currentTarget.value);
              }}
            >
              <option value="time-desc">时间：最新优先</option>
              <option value="time-asc">时间：最早优先</option>
              <option value="name-asc">名称：A → Z</option>
              <option value="name-desc">名称：Z → A</option>
              <option value="type-asc">类型：A → Z</option>
              <option value="type-desc">类型：Z → A</option>
            </select>
            {view === "recent" ? (
              <button
                className="button secondary manual-evaluation-action"
                disabled={
                  summaryBusy ||
                  manualEvaluationBusy ||
                  (selectedFileIds.size === 0 &&
                    selectedDirectoryIds.size === 0)
                }
                onClick={() => void manuallyEvaluateSelectedFiles()}
                type="button"
              >
                {manualEvaluationBusy ? "正在评估…" : "手动评估所选"}
              </button>
            ) : null}
          </div>
          {commands.queryTodayWorkspace ? (
            workspaceLoading && !workspacePage ? (
              <p className="empty">正在整理目录结构…</p>
            ) : workspacePage && workspacePage.entries.length > 0 ? (
              <WorkspaceTreeTable
                key={workspacePage.queryId}
                commands={commands}
                disabled={summaryBusy || manualEvaluationBusy}
                onDirectorySelection={(id, checked) =>
                  setSelectedDirectoryIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
                onFileContextMenu={(id, x, y) => {
                  setSelected(id);
                  setFileMenu({ id, x, y });
                }}
                onFileSelection={(id, checked) =>
                  setSelectedFileIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
                onNotice={setNotice}
                onOpenFile={(id) => void fileAction("open", id)}
                page={workspacePage}
                selectedDirectoryIds={selectedDirectoryIds}
                selectedFileIds={selectedFileIds}
                valueMode={view === "today" ? "automatic" : "manual"}
              />
            ) : (
              <p className="empty">
                {view === "today"
                  ? "今天的扫描范围内还没有发现新建或修改的文件。"
                  : "过去五天内没有发现符合规则的工作文件。"}
              </p>
            )
          ) : visibleFiles.length === 0 ? (
            <p className="empty">
              {view === "today"
                ? "今天的扫描范围内还没有发现新建或修改的文件。"
                : "过去五天内没有发现符合规则的工作文件。"}
            </p>
          ) : (
            <div className="file-table-wrap">
              <table className="file-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        aria-label="选择全部文件"
                        checked={allVisibleSelected}
                        disabled={summaryBusy || manualEvaluationBusy}
                        onChange={(event) =>
                          toggleVisibleSelection(event.currentTarget.checked)
                        }
                        type="checkbox"
                      />
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
                    <th scope="col">
                      {view === "today" ? "价值评估" : "手动评估"}
                    </th>
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
                        if (summaryBusy) return;
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
                          checked={selectedFileIds.has(file.id)}
                          disabled={summaryBusy || manualEvaluationBusy}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setSelectedFileIds((current) => {
                              const next = new Set(current);
                              if (checked) next.add(file.id);
                              else next.delete(file.id);
                              return next;
                            });
                          }}
                          type="checkbox"
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td
                        className="file-title"
                        title={filename(file.canonicalPath)}
                      >
                        <FileTypeIcon path={file.canonicalPath} />
                        <strong>{filename(file.canonicalPath)}</strong>
                      </td>
                      <td>
                        <time>{formatTime(file.modifiedAtUtcMs)}</time>
                      </td>
                      <td className="source-cell">{file.source}</td>
                      <td>
                        <button
                          className={`value-tag ${
                            fileCategory(file.canonicalPath) === "documents"
                              ? valueStatusClass(file.status)
                              : "status-unsupported"
                          }`}
                          type="button"
                          disabled={
                            fileCategory(file.canonicalPath) !== "documents"
                          }
                          title={
                            fileCategory(file.canonicalPath) !== "documents" ||
                            file.score == null
                              ? undefined
                              : `JEV 价值评分：${file.score.toFixed(2)}`
                          }
                          onClick={() =>
                            fileCategory(file.canonicalPath) === "documents"
                              ? void openUploadDialog(file.id)
                              : undefined
                          }
                        >
                          {fileCategory(file.canonicalPath) !== "documents"
                            ? "不评估"
                            : file.status === "待分析"
                              ? view === "today"
                                ? "评估中"
                                : "待手动评估"
                              : file.status}
                        </button>
                      </td>
                      <td>
                        <button
                          className="row-open"
                          type="button"
                          onClick={() => void fileAction("open", file.id)}
                        >
                          <span>打开</span>
                          <svg viewBox="0 0 12 12" aria-hidden="true">
                            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
                          </svg>
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
          ref={contextMenuRef}
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
          <button role="menuitem" onClick={() => openCodexHandoff(fileMenu.id)}>
            发送到 Codex
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
      {codexHandoff ? (
        <CodexDestinationDialog
          commands={commands}
          onClose={() => setCodexHandoff(null)}
          onCommitted={finishCodexHandoff}
          source={codexHandoff.source}
        />
      ) : null}
      {summaryConfirmation ? (
        <div className="upload-modal-backdrop" role="presentation">
          <section
            aria-label="确认分批总结"
            aria-modal="true"
            className="summary-confirm-modal"
            role="dialog"
          >
            <header>
              <div>
                <p className="eyebrow">大范围总结</p>
                <h2>确认分批总结</h2>
              </div>
            </header>
            <p>
              已选择 {summaryConfirmation.preparation.fileCount} 个文件，将分为{" "}
              {summaryConfirmation.preparation.batchCount}{" "}
              批处理，再合并为一份完整总结。
            </p>
            <p className="muted">
              任一批处理失败都会停止合并并明确提示，不会返回看似完整的结果。
            </p>
            <footer>
              <button
                className="button secondary"
                onClick={() => setSummaryConfirmation(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="button primary"
                onClick={() => {
                  const template = summaryConfirmation.template;
                  const selection = summaryConfirmation.selection;
                  setSummaryConfirmation(null);
                  void generateSummary(template, true, selection);
                }}
                type="button"
              >
                继续分批总结
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {summaryResult ? (
        <SummaryResultDialog
          commands={commands}
          result={summaryResult}
          onClose={() => setSummaryResult(null)}
          onNotice={setNotice}
        />
      ) : null}
    </section>
  );
}
