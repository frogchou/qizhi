import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import type { QizhiCommands, RagflowDataset } from "../../lib/tauri";

export type SummaryDialogState = {
  status: "generating" | "completed" | "failed";
  markdown: string;
  truncated: boolean;
  fileCount: number;
  templateTitle: string;
  error: string | null;
  batchProgress?: {
    current: number;
    total: number;
    phase: string;
  } | null;
};

type Props = {
  commands: QizhiCommands;
  result: SummaryDialogState;
  onClose: () => void;
  onNotice: (message: string) => void;
};

async function copyText(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const field = document.createElement("textarea");
  field.value = content;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("copy failed");
}

function artifactFilename(title: string) {
  const invalid = '<>:"/\\|?*';
  const safe = Array.from(title)
    .map((character) =>
      character.charCodeAt(0) < 32 || invalid.includes(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/[. ]+$/g, "")
    .slice(0, 100)
    .trim();
  return `${safe || "今日总结"}-${new Date().toISOString().slice(0, 10)}.md`;
}

function markdownForDisplay(markdown: string) {
  return markdown.replace(/\*\*([^*\n]*?\S)[ \t]+\*\*/g, "**$1** ");
}

export function SummaryResultDialog({
  commands,
  result,
  onClose,
  onNotice,
}: Props) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [datasets, setDatasets] = useState<RagflowDataset[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [startParsing, setStartParsing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoFollow = useRef(true);
  const complete = result.status === "completed";

  useEffect(() => {
    const content = contentRef.current;
    if (content && autoFollow.current) content.scrollTop = content.scrollHeight;
  }, [result.markdown]);

  async function saveMarkdown() {
    if (!commands.pickSummarySavePath || !commands.saveSummaryMarkdown) {
      setError("当前版本暂不支持另存总结。");
      return;
    }
    const suggested = artifactFilename(result.templateTitle);
    const path = await commands.pickSummarySavePath(suggested);
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      await commands.saveSummaryMarkdown({ content: result.markdown, path });
      onNotice("总结已保存为 Markdown 文件。");
    } catch {
      setError("无法保存总结，请重新选择保存位置。");
    } finally {
      setBusy(false);
    }
  }

  async function showUpload() {
    setUploadOpen(true);
    setError(null);
    if (datasets.length || !commands.listRagflowDatasets) return;
    try {
      setDatasets(await commands.listRagflowDatasets());
    } catch {
      setError("无法读取 RAGFlow 知识库。");
    }
  }

  async function upload() {
    if (!commands.uploadSummaryMarkdown || !datasetId) return;
    setBusy(true);
    setError(null);
    try {
      const output = await commands.uploadSummaryMarkdown({
        content: result.markdown,
        filename: artifactFilename(result.templateTitle),
        datasetId,
        parentPath: parentPath.trim() || null,
        startParsing,
      });
      onNotice(
        output.parsingStarted
          ? "总结已上传并开始解析。"
          : output.parsingError
            ? `总结已上传，但未能启动解析：${output.parsingError}`
            : "总结已上传到知识库。",
      );
      onClose();
    } catch {
      setError("总结上传失败，请检查 RAGFlow 连接和目标知识库。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-modal-backdrop" role="presentation">
      <section
        aria-label="工作总结"
        aria-modal="true"
        className="summary-result-modal"
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">{result.templateTitle}</p>
            <h2>工作总结</h2>
            <p>
              {result.fileCount} 个文件参与生成
              <span className={`summary-state summary-state-${result.status}`}>
                {result.status === "generating"
                  ? "正在生成总结…"
                  : result.status === "completed"
                    ? "生成完成"
                    : "生成失败"}
              </span>
            </p>
            {result.batchProgress ? (
              <p className="summary-batch-progress">
                {result.batchProgress.phase === "synthesizing"
                  ? "正在合并各批总结"
                  : `正在总结第 ${result.batchProgress.current}/${result.batchProgress.total} 批`}
              </p>
            ) : null}
          </div>
          <button
            aria-label="关闭总结"
            className="modal-close"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        {result.truncated ? (
          <p className="summary-warning">
            OpenAI 标记本次输出不完整，以下内容可能缺失。
          </p>
        ) : null}
        <div
          aria-live="polite"
          className="summary-markdown"
          onScroll={(event) => {
            const content = event.currentTarget;
            autoFollow.current =
              content.scrollHeight - content.scrollTop - content.clientHeight <
              48;
          }}
          ref={contentRef}
        >
          {result.markdown ? (
            <ReactMarkdown
              components={{
                a: ({ children, href }) => (
                  <a href={href} rel="noreferrer noopener" target="_blank">
                    {children}
                  </a>
                ),
              }}
              skipHtml
            >
              {markdownForDisplay(result.markdown)}
            </ReactMarkdown>
          ) : result.status === "generating" ? (
            <div className="summary-generating-placeholder">
              <span aria-hidden="true" className="summary-spinner" />
              <span>正在生成总结…</span>
            </div>
          ) : null}
        </div>
        {result.error ? <p className="summary-error">{result.error}</p> : null}
        {uploadOpen ? (
          <div className="summary-upload-fields">
            <label>
              目标知识库
              <select
                aria-label="总结目标知识库"
                value={datasetId}
                onChange={(event) => setDatasetId(event.currentTarget.value)}
              >
                <option value="">请选择知识库</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              知识库内目录（可选）
              <input
                aria-label="总结知识库内目录"
                value={parentPath}
                onChange={(event) => setParentPath(event.currentTarget.value)}
              />
            </label>
            <label className="upload-checkbox">
              <input
                checked={startParsing}
                onChange={(event) =>
                  setStartParsing(event.currentTarget.checked)
                }
                type="checkbox"
              />
              上传后立即解析
            </label>
          </div>
        ) : null}
        {error ? <p className="upload-error">{error}</p> : null}
        <footer>
          <button
            className="button secondary"
            disabled={busy || !complete}
            onClick={() =>
              void copyText(result.markdown)
                .then(() => onNotice("总结已复制到剪贴板。"))
                .catch(() => setError("无法复制总结。"))
            }
            type="button"
          >
            复制
          </button>
          <button
            className="button secondary"
            disabled={busy || !complete}
            onClick={() => void saveMarkdown()}
            type="button"
          >
            另存为 Markdown
          </button>
          {uploadOpen ? (
            <button
              className="button primary"
              disabled={busy || !complete || !datasetId}
              onClick={() => void upload()}
              type="button"
            >
              {busy ? "正在上传…" : "确认上传"}
            </button>
          ) : (
            <button
              className="button primary"
              disabled={busy || !complete}
              onClick={() => void showUpload()}
              type="button"
            >
              上传到知识库
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
