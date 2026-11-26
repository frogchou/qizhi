import { useFeedback } from "../../components/FeedbackNotice";
import { ControlIcon } from "../../components/ControlIcon";
import { useRef, useState } from "react";
import { MaterialBasketSelector } from "../materials/MaterialBasket";
import {
  factoryApi,
  factoryErrorMessage,
  factoryTransport,
  type LocalUpload,
  type UploadReceipt,
} from "./factory-client";
import { bytes } from "./factory-model";

function checkedUpload(upload: UploadReceipt | null): UploadReceipt {
  if (!upload?.id || !Number.isFinite(Date.parse(upload.expiresAt)))
    throw new Error("中台没有返回有效的附件凭据，请重新上传。");
  return upload;
}

export function useFactoryAttachments() {
  const [basketIds, setBasketIds] = useState<string[]>([]);
  const [local, setLocal] = useState<UploadReceipt[]>([]);
  const [failures, setFailures] = useState<
    { key: string; name?: string; text: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const notify = useFeedback("error");
  const running = useRef(false);
  const cached = useRef(new Map<string, UploadReceipt>());

  async function selectFiles(files?: File[]) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProgress("正在选择或上传附件…");
    const failed: string[] = [];
    function collect(results: LocalUpload[]) {
      const uploaded: UploadReceipt[] = [],
        issues: { key: string; name: string; text: string }[] = [];
      for (const entry of results) {
        if (entry.status === "failed") {
          issues.push({
            key: crypto.randomUUID(),
            name: entry.displayName,
            text:
              entry.displayName +
              "：" +
              (entry.error || "上传失败，请重新选择文件。"),
          });
        } else {
          uploaded.push(checkedUpload(entry.upload));
        }
      }
      setLocal((old) => [
        ...old,
        ...uploaded.filter((u) => !old.some((p) => p.id === u.id)),
      ]);
      if (issues.length) {
        failed.push(...issues.map((issue) => issue.text));
        setFailures((old) => [...old, ...issues]);
      }
    }
    function clearRetryErrors(names: Set<string>) {
      setFailures((old) => old.filter((e) => e.name && !names.has(e.name)));
    }
    try {
      if (files === undefined) {
        const results = await factoryApi.pickUploads();
        if (results.length)
          clearRetryErrors(new Set(results.map((entry) => entry.displayName)));
        collect(results);
      } else {
        clearRetryErrors(new Set(files.map((f) => f.name)));
        for (const [index, file] of files.entries()) {
          setProgress(
            "正在上传 " + (index + 1) + "/" + files.length + " · " + file.name,
          );
          try {
            const upload = checkedUpload(await factoryApi.uploadFile(file));
            collect([
              {
                displayName: file.name,
                status: "uploaded",
                upload,
                error: null,
              },
            ]);
          } catch (error) {
            collect([
              {
                displayName: file.name,
                status: "failed",
                upload: null,
                error: factoryErrorMessage(error),
              },
            ]);
          }
        }
      }
    } catch (error) {
      const text = factoryErrorMessage(error);
      failed.push(text);
      setFailures((old) => [...old, { key: crypto.randomUUID(), text }]);
    } finally {
      if (failed.length)
        notify(
          failed.length === 1
            ? failed[0]
            : failed.length + " 个附件上传失败，请查看附件列表。",
        );
      running.current = false;
      setBusy(false);
      setProgress("");
    }
  }

  async function resolveIds() {
    if (running.current) throw new Error("请等待附件上传完成。");
    if (failures.length)
      throw new Error("部分附件上传失败，请重新选择或移除失败项。");
    if (local.some((u) => Date.parse(u.expiresAt) <= Date.now()))
      throw new Error("本地附件已过暂存期，请移除并重新上传。");
    running.current = true;
    setBusy(true);
    try {
      const ids = local.map((u) => u.id);
      for (const [index, id] of basketIds.entries()) {
        let receipt = cached.current.get(id);
        if (!receipt || Date.parse(receipt.expiresAt) <= Date.now()) {
          setProgress(
            "正在上传资料筐中的第 " +
              (index + 1) +
              " / " +
              basketIds.length +
              " 项…",
          );
          receipt = checkedUpload(await factoryApi.uploadBasket(id));
          cached.current.set(id, receipt);
        }
        ids.push(receipt.id);
      }
      return [...new Set(ids)];
    } finally {
      running.current = false;
      setBusy(false);
      setProgress("");
    }
  }
  return {
    basketIds,
    setBasketIds,
    local,
    failures,
    busy,
    progress,
    selectFiles,
    resolveIds,
    count: local.length + basketIds.length,
    removeLocal: (id: string) =>
      setLocal((old) => old.filter((u) => u.id !== id)),
    removeFailure: (key: string) =>
      setFailures((old) => old.filter((e) => e.key !== key)),
  };
}

export function FactoryAttachments({
  attachments: a,
  disabled = false,
}: {
  attachments: ReturnType<typeof useFactoryAttachments>;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const locked = disabled || a.busy;
  const desktop = factoryTransport() === "desktop";
  const upload = (
    <button
      type="button"
      className="ui-action ui-small"
      disabled={locked}
      onClick={() => {
        if (desktop) void a.selectFiles();
        else input.current?.click();
      }}
    >
      <ControlIcon name="upload" size={16} /> 上传本地文件
    </button>
  );
  return (
    <fieldset className="live-attachments" disabled={locked}>
      <legend>附件与资料</legend>
      {!desktop && (
        <input
          ref={input}
          className="live-file-input"
          hidden
          type="file"
          multiple
          tabIndex={-1}
          aria-label="选择本地附件"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void a.selectFiles(files);
          }}
        />
      )}
      <MaterialBasketSelector
        compact
        leadingAction={upload}
        selectedIds={a.basketIds}
        onChange={a.setBasketIds}
        disabled={locked}
      />
      {a.local.map((u) => (
        <div className="live-upload-row" key={u.id}>
          <ControlIcon name="file" size={16} />
          <span>
            {u.displayName}
            <small>{bytes(u.sizeBytes)} · 已暂存</small>
          </span>
          <button
            type="button"
            className="ui-icon-button ui-close"
            title={"移除附件 " + u.displayName}
            aria-label={"移除附件 " + u.displayName}
            onClick={() => a.removeLocal(u.id)}
          >
            <ControlIcon name="x" size={14} />
          </button>
        </div>
      ))}
      {a.failures.map((e) => (
        <div className="live-upload-row" key={e.key}>
          <span>{e.text}</span>
          <button
            type="button"
            className="ui-action ui-quiet ui-small"
            onClick={() => a.removeFailure(e.key)}
          >
            移除失败项
          </button>
        </div>
      ))}

      {a.progress && <small role="status">{a.progress}</small>}
    </fieldset>
  );
}
