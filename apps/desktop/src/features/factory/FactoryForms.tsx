import { FeedbackNotice } from "../../components/FeedbackNotice";
import { useState } from "react";
import { TaskAuthorization, useTaskAuthorization } from "./TaskAuthorization";
import type { TaskScope } from "./assembly-model";
import { factoryApi } from "./factory-client";
import {
  FactoryAttachments,
  useFactoryAttachments,
} from "./FactoryAttachments";
import { Modal, useAction } from "./FactoryControls";
import type { OpenTask } from "./factory-model";

export function RequirementForm({
  seed,
  onClose,
  onCreated,
  refresh,
  stale,
}: {
  seed?: TaskScope;
  onClose: () => void;
  onCreated: OpenTask;
  refresh: () => void;
  stale: boolean;
}) {
  const attachments = useFactoryAttachments();
  const auth = useTaskAuthorization(seed);
  const [goal, setGoal] = useState(""),
    [manual, setManual] = useState(true),
    action = useAction(refresh);
  return (
    <Modal
      title="新建需求"
      closeDisabled={action.busy || attachments.busy}
      onClose={() => {
        if (!action.busy && !attachments.busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !goal.trim() ||
            !auth.ready ||
            stale ||
            attachments.busy ||
            attachments.failures.length
          )
            return;
          void action.run(async () => {
            const inputIds = await attachments.resolveIds();
            const result = await factoryApi.post<{
              taskId: string;
              state: string;
            }>("/v1/tasks", {
              goal: auth.goal(goal.trim()),
              acceptanceMode: manual ? "human_review" : "platform_auto",
              sourceSystem: "qizhi_desktop",
              ...auth.body,
              ...(inputIds.length ? { inputIds } : {}),
            });
            if (!result.taskId)
              throw new Error(
                "中台已响应，但没有返回工单号，请刷新接待大厅核对提交记录",
              );
            onCreated(result.taskId, goal.trim());
            onClose();
          });
        }}
      >
        <label>
          需求内容
          <textarea
            required
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="说明需要完成的工作、交付形式和验收要求"
          />
        </label>
        <FactoryAttachments
          attachments={attachments}
          disabled={action.busy || stale}
        />
        <TaskAuthorization auth={auth} disabled={action.busy || stale} />
        <label className="fc-check">
          <input
            type="checkbox"
            checked={manual}
            onChange={(e) => setManual(e.target.checked)}
          />{" "}
          由我确认最终交付
        </label>
        <p className="live-subtle">提交来源 · 栖知桌面端</p>
        <FeedbackNotice
          tone="error"
          message={stale ? "连接已中断，请在恢复后提交。" : ""}
        />
        <footer>
          <button
            type="button"
            className="ui-action ui-quiet"
            disabled={action.busy || attachments.busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="ui-action ui-primary"
            disabled={
              !goal.trim() ||
              !auth.ready ||
              action.busy ||
              attachments.busy ||
              !!attachments.failures.length ||
              stale
            }
          >
            提交并跟随
          </button>
        </footer>
      </form>
    </Modal>
  );
}
