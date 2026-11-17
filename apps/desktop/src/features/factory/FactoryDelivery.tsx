import ReactMarkdown from "react-markdown";
import { factoryApi } from "./factory-client";
import { taskDelivery } from "./factory-delivery";
import { ActionNotice, ContextHelp, Empty, useAction } from "./FactoryControls";
import { bytes, when, type TaskDetail } from "./factory-model";
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
  artifacts,
  busy,
  onDownload,
}: {
  artifacts: TaskDetail["artifacts"];
  busy: boolean;
  onDownload: (artifact: TaskDetail["artifacts"][number]) => void;
}) {
  return artifacts.map((artifact) => (
    <article className="live-card live-delivery-file" key={artifact.id}>
      <strong>{artifact.fileName}</strong>
      <small>
        修订 {artifact.revision} · {bytes(artifact.sizeBytes)} ·{" "}
        {artifact.mediaType}
      </small>
      <small>{when(artifact.createdAt)}</small>
      <button
        type="button"
        className="ui-action ui-small"
        disabled={busy}
        onClick={() => onDownload(artifact)}
      >
        下载 {artifact.fileName}
      </button>
      <details>
        <summary>文件校验</summary>
        <small>SHA-256</small>
        <code>{artifact.sha256}</code>
      </details>
    </article>
  ));
}

export function FactoryDelivery({ detail }: { detail: TaskDetail }) {
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
      <ActionNotice action={action} />
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
            artifacts={supporting}
            busy={action.busy}
            onDownload={onDownload}
          />
        </details>
      )}
    </section>
  );
}
