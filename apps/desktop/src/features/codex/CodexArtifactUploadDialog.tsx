import { useEffect, useState } from "react";

import type {
  CodexArtifact,
  CodexArtifactUpload,
  QizhiCommands,
  RagflowDataset,
} from "../../lib/tauri";

export function CodexArtifactUploadDialog({
  artifact,
  commands,
  onClose,
  onUploaded,
}: {
  artifact: CodexArtifact;
  commands: QizhiCommands;
  onClose: () => void;
  onUploaded: (upload: CodexArtifactUpload) => void;
}) {
  const [datasets, setDatasets] = useState<RagflowDataset[]>([]);
  const [history, setHistory] = useState<CodexArtifactUpload[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [startParsing, setStartParsing] = useState(true);
  const [duplicateConfirmation, setDuplicateConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([
      commands.listRagflowDatasets?.() ?? [],
      commands.listCodexArtifactUploads?.(artifact.id) ?? [],
    ])
      .then(([nextDatasets, nextHistory]) => {
        setDatasets(nextDatasets);
        setHistory(nextHistory);
      })
      .catch((reason) => setError(message(reason)));
  }, [artifact.id]);

  async function upload(confirmDuplicate: boolean) {
    if (!datasetId || !commands.uploadCodexArtifact || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await commands.uploadCodexArtifact({
        artifactId: artifact.id,
        datasetId,
        parentPath: parentPath.trim() || null,
        startParsing,
        confirmDuplicate,
      });
      onUploaded(result);
      onClose();
    } catch (reason) {
      const text = message(reason);
      setError(text);
      setDuplicateConfirmation(text.includes("已上传到此知识库"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="codex-dialog-backdrop" role="presentation">
      <section
        className="codex-project-dialog codex-artifact-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-artifact-upload-title"
      >
        <div className="codex-dialog-icon">⇧</div>
        <div>
          <p>生成物入库</p>
          <h2 id="codex-artifact-upload-title">上传到 RAGFlow</h2>
          <span title={artifact.relativePath}>{artifact.relativePath}</span>
        </div>
        <label>
          目标知识库
          <select
            aria-label="目标知识库"
            value={datasetId}
            onChange={(event) => {
              setDatasetId(event.currentTarget.value);
              setDuplicateConfirmation(false);
            }}
          >
            <option value="">请选择知识库</option>
            {datasets.map((dataset) => (
              <option value={dataset.id} key={dataset.id}>
                {dataset.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          知识库内目录
          <input
            aria-label="知识库内目录"
            value={parentPath}
            onChange={(event) => setParentPath(event.currentTarget.value)}
            placeholder="可选，例如 reports/2026"
          />
        </label>
        <label className="codex-upload-check">
          <input
            type="checkbox"
            checked={startParsing}
            onChange={(event) => setStartParsing(event.currentTarget.checked)}
          />
          上传后立即解析
        </label>
        {history[0] ? (
          <p className="codex-upload-history">
            最近记录：{uploadStatus(history[0].status)}
          </p>
        ) : null}
        {error ? <div className="codex-upload-error">{error}</div> : null}
        <div className="codex-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          {duplicateConfirmation ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void upload(true)}
            >
              确认再次上传
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || !datasetId}
              onClick={() => void upload(false)}
            >
              {startParsing ? "上传并解析" : "仅上传"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function uploadStatus(status: string) {
  if (status === "uploaded") return "上传成功";
  if (status === "uploaded_parse_failed") return "已上传，解析未启动";
  if (status === "uncertain") return "结果不确定，请检查知识库";
  if (status === "failed") return "上传失败";
  return status;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
