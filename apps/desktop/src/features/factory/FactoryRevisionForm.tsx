import { FeedbackNotice } from "../../components/FeedbackNotice";
import { useRef, useState } from "react";
import { factoryApi } from "./factory-client";
import { ContextHelp, Modal, useAction } from "./FactoryControls";
import {
  FactoryAttachments,
  useFactoryAttachments,
} from "./FactoryAttachments";

export type RevisionDecision = "revise" | "amend";
export function RevisionForm({
  taskId,
  reviewId,
  decision,
  stale,
  onClose,
  onSubmitted,
}: {
  taskId: string;
  reviewId: string | null;
  decision: RevisionDecision;
  stale: boolean;
  onClose: () => void;
  onSubmitted: (revision: number) => void;
}) {
  const [message, setMessage] = useState("");
  const attachments = useFactoryAttachments();
  const action = useAction();
  const retry = useRef<{ body: string; key: string } | null>(null);
  const amend = decision === "amend";
  const title = amend ? "补充需求" : "退回重制";
  const busy = action.busy || attachments.busy;
  const valid = !amend || Boolean(message.trim() || attachments.count);
  function close() {
    if (!busy) onClose();
  }
  async function submit() {
    const inputIds = await attachments.resolveIds();
    const body = {
      decision,
      ...(reviewId ? { reviewId } : {}),
      message: message.trim(),
      inputIds,
    };
    const fingerprint = JSON.stringify(body);
    if (!retry.current || retry.current.body !== fingerprint)
      retry.current = { body: fingerprint, key: crypto.randomUUID() };
    const receipt = await factoryApi.post<{
      taskId: string;
      decision: RevisionDecision;
      revisionNumber: number;
      revisionId: string;
    }>(`/v1/tasks/${encodeURIComponent(taskId)}/review`, body, {
      idempotencyKey: retry.current.key,
    });
    if (
      receipt.taskId !== taskId ||
      receipt.decision !== decision ||
      !receipt.revisionId ||
      !(receipt.revisionNumber > 0)
    )
      throw new Error("中台没有返回本轮修订记录，请刷新工单核对。");
    onSubmitted(receipt.revisionNumber);
  }
  return (
    <Modal title={title} onClose={close} closeDisabled={busy}>
      <form
        className="live-revision-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy && !stale && !attachments.failures.length)
            void action.run(submit);
        }}
      >
        <label>
          {amend ? "补充要求" : "重制意见（可选）"}
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={4000}
            autoFocus
            placeholder={
              amend
                ? "填写新增要求，也可以只添加资料"
                : "说明需要改动的内容，或按已有要求重新制作"
            }
          />
        </label>
        <FactoryAttachments
          attachments={attachments}
          disabled={action.busy || stale}
        />
        <p className="live-subtle">
          中台将在当前工单重新编排。上一轮的成果和验收记录可随时查看。
          <ContextHelp id="revision" />
        </p>
        <FeedbackNotice
          tone="error"
          message={stale ? "连接已中断，请在恢复后提交。" : ""}
        />
        <footer>
          <button
            type="button"
            className="ui-action ui-quiet"
            disabled={busy}
            onClick={close}
          >
            取消
          </button>
          <button
            className="ui-action ui-primary"
            disabled={busy || !valid || stale || !!attachments.failures.length}
          >
            {amend ? "提交补充需求" : "确认退回重制"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
