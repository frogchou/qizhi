import { useEffect, useId } from "react";
import { FeedbackNotice, useFeedback } from "../../components/FeedbackNotice";
import { Badge } from "./FactoryControls";
import {
  pendingOperation,
  type AssemblyDraft,
  type AssemblyOperation,
  type AssemblyRun,
  type Candidate,
  type FocusedOptimization,
  type OptimizationReceipt,
  type OptimizationSource,
} from "./assembly-model";
import { factoryMessage, stateName, when } from "./factory-model";
import { safeFactoryId } from "./factory-routes";

export type OptimizationActions = {
  submitting: boolean;
  unavailable?: string;
  focused: FocusedOptimization | null;
  registeredSource?: OptimizationSource | null;
  submit: (
    source: OptimizationSource,
    revision: number,
    feedback: string,
    reviewId?: string | null,
  ) => void;
  open: (source: OptimizationSource, receipt: OptimizationReceipt) => void;
};

export function validOptimizationReceipt(receipt: OptimizationReceipt | null) {
  return Boolean(
    receipt &&
    typeof receipt.draftId === "string" &&
    safeFactoryId(receipt.draftId) &&
    typeof receipt.operationId === "string" &&
    safeFactoryId(receipt.operationId) &&
    Number.isSafeInteger(receipt.revision) &&
    receipt.revision > 0 &&
    ["queued", "running", "completed", "failed", "cancelled"].includes(
      receipt.state,
    ),
  );
}

function blockOptimization(
  draft: AssemblyDraft,
  candidate: Candidate,
  run: AssemblyRun,
  dirty: boolean,
  released: boolean,
) {
  if (
    run.candidateId !== candidate.id ||
    (run.packageDigest !== undefined &&
      run.packageDigest !== candidate.packageDigest)
  )
    return "测试记录与所选生成版本的包摘要不匹配，请重新选择测试记录。";
  if (
    ![
      "failed",
      "planning_failed",
      "cancelled",
      "awaiting_review",
      "accepted",
    ].includes(run.state)
  )
    return "本次测试仍在进行，请等测试结束或出现验收结果后再优化。";
  if (released) return;
  if (draft.deletedAt)
    return "这份组装记录已归档。请打开已登记版本的测试记录。";
  if (dirty)
    return "当前组装有未保存的修改。请返回智能体组装，保存后重新生成并测试。";
  if (candidate.revision !== draft.revision)
    return "组装内容在此次生成后已有修改，请用当前配置生成并测试后再优化。";
}

export function TrialOptimization({
  actions,
  draft,
  candidate,
  run,
  dirty,
  feedback,
  waiting,
  onKeepSelection,
  onNeedFeedback,
  onRestoreFeedback,
  onEditDraft,
}: {
  actions: OptimizationActions;
  draft: AssemblyDraft;
  candidate: Candidate;
  run: AssemblyRun;
  dirty: boolean;
  feedback: string;
  waiting: boolean;
  onKeepSelection: () => void;
  onNeedFeedback: () => void;
  onRestoreFeedback: (text: string) => void;
  onEditDraft: () => void;
}) {
  const notify = useFeedback();
  const hint = useId();
  useEffect(() => () => notify(null), [notify, feedback, dirty]);
  const source = {
    draftId: draft.id,
    candidateId: candidate.id,
    runId: run.id,
    packageDigest: candidate.packageDigest,
  };
  const history = run.optimizations ?? [];
  const registration = actions.registeredSource;
  const released = candidate.releaseStatus
    ? !["deleted", "deleting"].includes(candidate.releaseStatus)
    : registration?.draftId === draft.id &&
      registration.candidateId === candidate.id &&
      registration.packageDigest === candidate.packageDigest;
  const recent =
    actions.focused?.source.draftId === draft.id &&
    actions.focused.source.runId === run.id
      ? actions.focused
      : null;
  const awaitingHistory =
    recent &&
    pendingOperation(recent) &&
    !history.some((item) => item.operationId === recent.operationId)
      ? recent
      : null;
  const pending = history.find(pendingOperation) ?? awaitingHistory;
  const needsFeedback =
    run.optimizationNeedsFeedback ??
    !(
      ["failed", "planning_failed"].includes(run.state) ||
      run.assertions.some((a) => !a.passed) ||
      run.findings?.some(
        (f) => f.status === "missing" || f.status === "uncertain",
      )
    );
  const blocked =
    actions.unavailable ??
    blockOptimization(draft, candidate, run, dirty, released);
  const text = feedback.trim();
  return (
    <div className="studio-trial-optimization">
      <div className="studio-actions">
        <button
          type="button"
          className="ui-action"
          aria-describedby={hint}
          disabled={waiting || actions.submitting || Boolean(pending)}
          onClick={() => {
            onKeepSelection();
            if (blocked) return notify(blocked, "info");
            if (!text && needsFeedback) {
              onNeedFeedback();
              return notify(
                "请填写希望改进的内容，再按本次测试反馈优化。",
                "info",
              );
            }
            notify(null);
            actions.submit(source, draft.revision, text, run.reviewId);
          }}
        >
          根据反馈优化
        </button>
        {dirty && !released && !draft.deletedAt && (
          <button
            type="button"
            className="ui-action ui-small"
            onClick={onEditDraft}
          >
            查看未保存的修改
          </button>
        )}
      </div>
      <p className="live-subtle" id={hint}>
        {pending
          ? "本次反馈正在生成新版本。"
          : (blocked ??
            (released
              ? "优化将在新的升级草稿中生成候选版本。"
              : needsFeedback
                ? "写明希望改进的内容，再生成新版本。"
                : "可直接使用本次测试的诊断，也可补充意见后优化。"))}
      </p>
      {awaitingHistory && (
        <button
          type="button"
          className="ui-action ui-small"
          onClick={() => actions.open(source, awaitingHistory)}
        >
          查看优化进度
        </button>
      )}
      {history.length > 0 && (
        <details
          className="assembly-disclosure"
          open={pending ? true : undefined}
        >
          <summary>优化记录（{history.length}）</summary>
          {history.map((item) => (
            <div key={item.operationId} className="studio-optimization-record">
              <span>
                {when(item.createdAt)} · {stateName(item.state)}
              </span>
              <p>{item.feedback || "使用本次测试的系统诊断"}</p>
              <button
                type="button"
                className="ui-action ui-small"
                onClick={() => actions.open(source, item)}
              >
                查看优化进度
              </button>
              {item.state === "failed" && item.feedback && !feedback && (
                <button
                  type="button"
                  className="ui-action ui-small"
                  onClick={() => {
                    onRestoreFeedback(item.feedback);
                    onNeedFeedback();
                  }}
                >
                  沿用这次意见
                </button>
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function OptimizationProgress({
  focus,
  operation,
  candidate,
  onTest,
  onOriginal,
}: {
  focus: FocusedOptimization;
  operation?: AssemblyOperation;
  candidate?: Candidate;
  onTest: (candidateId: string) => void;
  onOriginal: () => void;
}) {
  const state = operation?.state ?? focus.state;
  const reason = operation?.message && factoryMessage(operation.message);
  const failed = state === "failed";
  const status =
    state === "completed"
      ? candidate
        ? "优化版本已生成"
        : "正在读取已生成的版本"
      : failed
        ? "本次优化生成失败"
        : state === "cancelled"
          ? "本次优化已停止"
          : state === "running"
            ? "正在根据测试反馈生成智能体"
            : "反馈优化已排队";
  return (
    <section className="studio-optimization-progress" aria-label="反馈优化进度">
      <div role="status">
        <strong>{status}</strong> <Badge value={state} />
        {reason && <p>{reason}</p>}
      </div>
      <div className="studio-actions">
        {state === "completed" && candidate && (
          <button
            type="button"
            className="ui-action ui-primary ui-small"
            onClick={() => onTest(candidate.id)}
          >
            测试优化后的版本
          </button>
        )}
        <button
          type="button"
          className="ui-action ui-small"
          onClick={onOriginal}
        >
          返回原测试
        </button>
      </div>
      <FeedbackNotice
        message={failed ? reason || "反馈优化生成失败，请返回原测试重试。" : ""}
        tone="error"
      />
    </section>
  );
}
