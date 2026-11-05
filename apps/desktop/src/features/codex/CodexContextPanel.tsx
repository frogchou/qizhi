import type {
  CodexArtifact,
  CodexMaterial,
  CodexMaterialSourceStatus,
} from "../../lib/tauri";

export function CodexContextPanel({
  materials,
  materialStatuses,
  artifacts,
  importing,
  locked = false,
  onImport,
  onRemoveMaterial,
  onRefreshMaterial,
  onRevealMaterialSource,
  onOpenArtifact,
  onRevealArtifact,
  onExportArtifact,
  onUploadArtifact,
}: {
  materials: CodexMaterial[];
  materialStatuses: CodexMaterialSourceStatus[];
  artifacts: CodexArtifact[];
  importing: boolean;
  locked?: boolean;
  onImport: () => void;
  onRemoveMaterial: (id: string) => void;
  onRefreshMaterial: (id: string) => void;
  onRevealMaterialSource: (id: string) => void;
  onOpenArtifact: (path: string) => void;
  onRevealArtifact: (path: string) => void;
  onExportArtifact: (path: string) => void;
  onUploadArtifact: (artifact: CodexArtifact) => void;
}) {
  return (
    <aside className="codex-context-panel">
      <section>
        <div className="codex-context-heading">
          <div>
            <span>项目资料</span>
            <strong>{materials.length} 项</strong>
          </div>
          <button
            type="button"
            onClick={onImport}
            disabled={importing || locked}
          >
            ＋ 添加
          </button>
        </div>
        <p className="codex-context-note">
          Codex 可读取这些资料的安全快照，不会修改原文件。
        </p>
        <div className="codex-context-list">
          {materials.length ? (
            materials.map((material) => {
              const source = materialStatuses.find(
                (status) => status.materialId === material.id,
              );
              return (
                <div className="codex-context-item material" key={material.id}>
                  <span className="codex-file-icon">▤</span>
                  <span>
                    <strong title={material.displayName}>
                      {material.displayName}
                    </strong>
                    <small>
                      {sourceStateLabel(
                        source?.state ?? material.snapshotState,
                      )}
                    </small>
                    {source ? (
                      <small
                        className="codex-material-source"
                        title={source.sourceLabel}
                      >
                        {source.sourceLabel}
                      </small>
                    ) : null}
                    <span className="codex-material-actions">
                      {source?.revealable ? (
                        <button
                          type="button"
                          onClick={() => onRevealMaterialSource(material.id)}
                        >
                          查看来源
                        </button>
                      ) : null}
                      {source?.refreshable ? (
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => onRefreshMaterial(material.id)}
                        >
                          刷新
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => onRemoveMaterial(material.id)}
                      >
                        移除
                      </button>
                    </span>
                  </span>
                </div>
              );
            })
          ) : (
            <p className="codex-context-empty">
              还没有资料。加入文档、表格、演示或文本供 Codex 使用。
            </p>
          )}
        </div>
      </section>
      <section className="codex-artifacts">
        <div className="codex-context-heading">
          <div>
            <span>生成物</span>
            <strong>{artifacts.length} 项</strong>
          </div>
        </div>
        <div className="codex-context-list">
          {artifacts.length ? (
            artifacts.map((artifact) => (
              <div className="codex-context-item artifact" key={artifact.id}>
                <span className="codex-file-icon output">↗</span>
                <span>
                  <strong title={artifact.relativePath}>
                    {artifact.relativePath}
                  </strong>
                  <small>{formatBytes(artifact.sizeBytes)}</small>
                  <span className="artifact-actions">
                    <button
                      type="button"
                      onClick={() => onOpenArtifact(artifact.relativePath)}
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      onClick={() => onRevealArtifact(artifact.relativePath)}
                    >
                      定位
                    </button>
                    <button
                      type="button"
                      onClick={() => onExportArtifact(artifact.relativePath)}
                    >
                      导出
                    </button>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => onUploadArtifact(artifact)}
                    >
                      上传
                    </button>
                  </span>
                </span>
              </div>
            ))
          ) : (
            <p className="codex-context-empty">
              Codex 生成的文件会出现在这里。
            </p>
          )}
        </div>
      </section>
      <footer>
        <span className="status-dot" />
        本机 Codex · 扩展能力沿用本机设置
      </footer>
    </aside>
  );
}

function sourceStateLabel(state: string) {
  switch (state) {
    case "ready":
      return "快照已同步";
    case "source_changed":
      return "来源已有更新";
    case "source_missing":
      return "来源不可用";
    case "snapshot_only":
      return "仅保留检索快照";
    case "original_only":
      return "仅原件 · 读取能力不确定";
    default:
      return state || "已准备";
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
