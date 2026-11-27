import { useCallback, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { factoryApi } from "./factory-client";
import { taskDelivery } from "./factory-delivery";
import { ContextHelp, Empty, useAction } from "./FactoryControls";
import {
  bytes,
  errorText,
  stateName,
  when,
  type TaskDetail,
} from "./factory-model";
import "./factory-delivery.css";

function DeliveryBody({
  body,
  format,
}: {
  body: string;
  format: "markdown" | "text";
}) {
  if (format === "text") return <div className="live-prose">{body}</div>;
  return (
    <div className="live-delivery-markdown">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children, href }) =>
            href && /^(https?:\/\/|mailto:)/i.test(href) ? (
              <a href={href} rel="noreferrer noopener" target="_blank">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function DeliveryFiles({
  taskId,
  artifacts,
  busy,
  onDownload,
}: {
  taskId: string;
  artifacts: TaskDetail["artifacts"];
  busy: boolean;
  onDownload: (artifact: TaskDetail["artifacts"][number]) => void;
}) {
  return artifacts.map((artifact) => (
    <article
      className="live-card live-delivery-file"
      key={taskId + ":" + artifact.id}
    >
      <strong>{artifact.fileName}</strong>
      <small>
        修订 {artifact.revision} · {bytes(artifact.sizeBytes)} ·{" "}
        {artifact.mediaType}
      </small>
      <small>{when(artifact.createdAt)}</small>
      <ArtifactActions
        taskId={taskId}
        artifact={artifact}
        busy={busy}
        onDownload={() => onDownload(artifact)}
      />
      <details>
        <summary>文件校验</summary>
        <small>SHA-256</small>
        <code>{artifact.sha256}</code>
      </details>
    </article>
  ));
}

function ArtifactActions({
  taskId,
  artifact,
  busy,
  onDownload,
}: {
  taskId: string;
  artifact: TaskDetail["artifacts"][number];
  busy: boolean;
  onDownload: () => void;
}) {
  const region = useId();
  const [preview, setPreview] = useState<{
    url?: string;
    error?: string;
  } | null>(null);
  const active = useRef<{ controller: AbortController; url?: string } | null>(
    null,
  );
  const dispose = useCallback(() => {
    active.current?.controller.abort();
    if (active.current?.url) URL.revokeObjectURL(active.current.url);
    active.current = null;
  }, []);
  useEffect(() => dispose, [dispose]);
  async function toggle() {
    if (active.current) {
      dispose();
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    active.current = { controller };
    setPreview({});
    try {
      const file = await factoryApi.previewPng(
        taskId,
        artifact.id,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(file);
      active.current.url = url;
      setPreview({ url });
    } catch (err) {
      if (!controller.signal.aborted) setPreview({ error: errorText(err) });
    }
  }
  const png =
    /^image\/png(?:;|$)/i.test(artifact.mediaType) ||
    /\.png$/i.test(artifact.fileName);
  return (
    <div className="live-png-preview">
      <div className="fc-actions">
        {png && (
          <button
            type="button"
            className="ui-action ui-small"
            aria-expanded={!!preview}
            aria-controls={region}
            onClick={() => void toggle()}
          >
            {preview ? "收起预览 " : "预览 "}
            {artifact.fileName}
          </button>
        )}
        <button
          type="button"
          className="ui-action ui-small"
          disabled={busy}
          onClick={onDownload}
        >
          下载 {artifact.fileName}
        </button>
      </div>
      <div id={region} hidden={!preview}>
        {preview?.error ? (
          <p role="alert">{preview.error}</p>
        ) : preview?.url ? (
          <img
            src={preview.url}
            alt={artifact.fileName}
            onError={() =>
              setPreview({ error: "这份归档图片无法解码，可下载原文件核对。" })
            }
          />
        ) : (
          preview && <p role="status">正在读取归档图片…</p>
        )}
      </div>
    </div>
  );
}

function DeliveryReview({ detail }: { detail: TaskDetail }) {
  const rounds = detail.acceptanceRounds.filter(
    (r) => (r.revision_number ?? 0) === (detail.task.revision_number ?? 0),
  );
  const current = detail.currentReviewId
    ? rounds.find((round) => round.id === detail.currentReviewId)
    : rounds.sort((a, b) => b.round - a.round)[0];
  if (!current) return null;
  const findings = new Map(
    current.assessment?.items?.map((item) => [item.id, item.status]),
  );
  for (const criterion of current.criteria ?? [])
    if (!findings.has(criterion.id)) findings.set(criterion.id, "unrecorded");
  const counts = new Map<string, number>();
  for (const status of findings.values())
    counts.set(status, (counts.get(status) ?? 0) + 1);
  const assessment = Array.from(
    counts,
    ([status, count]) => stateName(status) + " " + count + " 项",
  ).join("、");
  return (
    <section className="live-delivery-review" aria-label="本轮验收">
      <strong>
        第 {current.round} 轮
        {current.decision === "accept"
          ? "已由人工验收通过"
          : current.decision
            ? "人工决定 · " + stateName(current.decision)
            : "尚无人工决定"}
      </strong>
      <span>自动核验 · {assessment || "尚无逐项结果"}</span>
    </section>
  );
}

export function FactoryDelivery({
  detail,
  showReview = true,
}: {
  detail: TaskDetail;
  showReview?: boolean;
}) {
  const action = useAction();
  const delivery = taskDelivery(detail);
  const artifacts = new Map(
    detail.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  const files = (ids: string[]) =>
    [...new Set(ids)].flatMap((id) => {
      const artifact = artifacts.get(id);
      return artifact ? [artifact] : [];
    });
  const deliverables = files(delivery.artifactIds);
  const supporting = files(
    delivery.supportingArtifactIds.filter(
      (id) => !delivery.artifactIds.includes(id),
    ),
  );
  const onDownload = (artifact: TaskDetail["artifacts"][number]) =>
    void action.run(async () =>
      (await factoryApi.download(
        detail.task.id,
        artifact.id,
        artifact.fileName,
      ))
        ? "已保存 " + artifact.fileName
        : "已取消保存",
    );
  const copy = () =>
    void action.run(async () => {
      if (!navigator.clipboard?.writeText)
        throw new Error("当前环境无法复制，请选择正文复制。");
      const body =
        delivery.answers.length === 1
          ? delivery.answers[0].body
          : delivery.answers
              .map((answer) => "# " + answer.title + "\n\n" + answer.body)
              .join("\n\n");
      await navigator.clipboard.writeText(body);
      return "已复制完整成果";
    });

  return (
    <section className="live-delivery" aria-label="任务成果">
      <header className="live-delivery-heading">
        <h3>
          任务成果
          <ContextHelp id="artifact" />
        </h3>
        {delivery.answers.length > 0 && (
          <button
            type="button"
            className="ui-action ui-small"
            disabled={action.busy}
            onClick={copy}
          >
            复制完整成果
          </button>
        )}
      </header>
      {showReview && <DeliveryReview detail={detail} />}
      {delivery.answers.map((answer, index) => (
        <article
          className="live-card live-delivery-answer"
          key={answer.nodeKey + ":" + index}
        >
          <h4>{answer.title}</h4>
          <DeliveryBody body={answer.body} format={answer.format} />
        </article>
      ))}
      {deliverables.length > 0 && (
        <section aria-label="交付文件">
          <h3>
            交付文件
            <ContextHelp id="artifact" />
          </h3>
          <DeliveryFiles
            taskId={detail.task.id}
            artifacts={deliverables}
            busy={action.busy}
            onDownload={onDownload}
          />
        </section>
      )}
      {!delivery.answers.length && !deliverables.length && (
        <Empty>本次修订尚无可展示的成果</Empty>
      )}
      {supporting.length > 0 && (
        <details className="live-delivery-records">
          <summary>执行与质检记录（{supporting.length}）</summary>
          <DeliveryFiles
            taskId={detail.task.id}
            artifacts={supporting}
            busy={action.busy}
            onDownload={onDownload}
          />
        </details>
      )}
    </section>
  );
}
