import type { CodexHandoffDetails } from "../../lib/tauri";

export function CodexPendingMaterials({
  handoffs,
  disabled,
  onDismiss,
}: {
  handoffs: CodexHandoffDetails[];
  disabled: boolean;
  onDismiss: (handoffId: string, materialId: string) => Promise<void>;
}) {
  const items = handoffs.flatMap((handoff) =>
    handoff.items
      .filter((item) => item.state === "ready")
      .map((item) => ({ handoffId: handoff.handoff.id, item })),
  );
  if (!items.length) return null;
  return (
    <div className="codex-pending-materials" aria-label="本轮待用资料">
      <span className="codex-pending-label">本轮资料</span>
      <div>
        {items.map(({ handoffId, item }) => (
          <span className="codex-pending-chip" key={item.id}>
            <i aria-hidden="true">▤</i>
            <span title={item.displayName}>{item.displayName}</span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除待用资料 ${item.displayName}`}
              onClick={() => void onDismiss(handoffId, item.materialId)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <small>发送下一条任务时，Codex 会优先阅读这些安全快照</small>
    </div>
  );
}
