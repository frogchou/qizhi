export type BasketItem = {
  id: string;
  kind: "local" | "today" | "recent" | "ragflowChunk" | "ragflowDocument";
  displayName: string;
  sourceLabel: string;
  sizeBytes: number;
  sha256: string;
  addedAtUtcMs: number;
};
export type BasketSource =
  | {
      kind: "today" | "recent";
      queryId: string;
      fileIds: number[];
      directoryIds: string[];
    }
  | {
      kind: "ragflowChunks";
      selectionToken: string;
      chunks: { datasetId: string; documentId: string; chunkId: string }[];
    }
  | {
      kind: "ragflowDocuments";
      selectionToken: string;
      documents: { datasetId: string; documentId: string }[];
    };
export type BasketResult = {
  key: string;
  displayName: string;
  status: "added" | "existing" | "failed";
  item: BasketItem | null;
  error: string | null;
};
export type BasketAttachment = {
  itemIds: string[];
  projectId: string;
  conversationId: string;
  requestId: string;
};
export const basketUnavailable = "本机资料筐需要栖知桌面端。";
export const basketError = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "资料筐操作未完成";
export function basketResultMessage(results: BasketResult[]) {
  const added = results.filter((r) => r.status === "added").length,
    existing = results.filter((r) => r.status === "existing").length,
    failed = results.filter((r) => r.status === "failed");
  const parts = [
    added ? "已加入 " + added + " 项" : null,
    existing ? "筐中已有 " + existing + " 项" : null,
    ...failed.map((r) => r.displayName + "：" + (r.error || "未能加入")),
  ].filter(Boolean);
  return parts.join(" · ") || "没有可加入的资料";
}
export function basketSize(size: number) {
  return size < 1024
    ? size + " B"
    : size < 1048576
      ? (size / 1024).toFixed(1) + " KiB"
      : (size / 1048576).toFixed(1) + " MiB";
}
