import { useId, useRef, useState } from "react";
import { useFeedback } from "../../components/FeedbackNotice";
import { factoryApi } from "./factory-client";
import { stateName, when } from "./factory-model";
import type { useAction } from "./FactoryControls";
import {
  TrialOptimization,
  type OptimizationActions,
} from "./TrialOptimization";
import {
  draftPath,
  trialBlock,
  useRequestId,
  type AssemblyDraft,
  type AssemblyRun,
  type Candidate,
  type TrialBlock,
} from "./assembly-model";

export function SampleReview({
  run,
  requiresImage,
}: {
  run: AssemblyRun;
  requiresImage?: boolean;
}) {
  return (
    <>
      <h4>样例验收条件</h4>
      {requiresImage && (
        <p>
          原生图片核验 ·{" "}
          {run.hasRequiredNativeImage === true
            ? "已核对本次生图回执与归档 PNG"
            : run.hasRequiredNativeImage === false
              ? "尚无与本次生图回执匹配的归档 PNG"
              : "中台尚未报告结果"}
        </p>
      )}
      {run.reviewDecision === "accept" && run.state === "accepted" && (
        <p>
          工单第 {run.reviewRound} 轮已由人工验收通过
          {run.reviewDecidedAt ? " · " + when(run.reviewDecidedAt) : ""}
        </p>
      )}
      {run.criteria?.length ? (
        <ul className="assembly-assertions">
          {run.criteria.map((c) => {
            const finding = run.findings?.find((f) => f.id === c.id);
            return (
              <li key={c.id}>
                <strong>{c.requirement}</strong>
                <span>
                  {c.priority === "required" ? "必需" : "参考"} · 自动核验
                  {finding ? " · " + stateName(finding.status) : "尚无结果"}
                </span>
                {finding?.reason && <small>{finding.reason}</small>}
                {Boolean(finding?.evidenceIds?.length) && (
                  <small>依据 {finding!.evidenceIds!.join("、")}</small>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="live-subtle">工单尚未给出逐项验收结果。</p>
      )}
    </>
  );
}

type Remedy = NonNullable<TrialBlock["action"]>;
const remedyLabel: Record<Remedy, string> = {
  review: "去工单人工复核",
  edit: "返回智能体组装",
  sample: "填写新测试样例",
  plan: "查看工单进度",
  manage: "查看发布版本",
  currentBuild: "切换到当前草稿的生成记录",
};

function releaseBlock(
  draft: AssemblyDraft,
  candidate: Candidate,
  run: AssemblyRun,
  dirty: boolean,
  testBlock: TrialBlock | null,
  submitted: boolean,
): TrialBlock | null {
  const released = draft.candidates.find(
    (c) =>
      c.agentId === candidate.agentId &&
      c.version === candidate.version &&
      c.releaseStatus,
  );
  if (submitted || released) {
    const other =
      released &&
      (released.id !== candidate.id ||
        (released.publishedRunId && released.publishedRunId !== run.id));
    return {
      message: other
        ? "这个版本号已使用另一份测试结果提交发布。请查看已登记的版本，或从它发起升级。"
        : "这个版本已提交发布，可在版本管理中查看审核进度。",
      action: "manage",
    };
  }
  if (dirty)
    return {
      message:
        "当前草稿有未保存的修改。请返回组装，保存后按最新内容生成并测试。",
      action: "edit",
    };
  if (draft.revision !== candidate.revision) {
    const hasCurrent = draft.candidates.some(
      (c) => c.revision === draft.revision,
    );
    return hasCurrent
      ? {
          message:
            "这份测试属于之前的草稿。请切换到当前草稿对应的生成记录，选用它的测试结果。",
          action: "currentBuild",
        }
      : {
          message:
            "草稿在这次生成后已有修改。请返回组装，用当前草稿重新生成并测试。",
          action: "edit",
        };
  }
  if (testBlock) return testBlock;
  if (!run.accepted || run.state !== "accepted")
    return { message: "请先认可这份测试结果，再提交发布审核。" };
  return null;
}

export function TrialAcceptance({
  draft,
  candidate,
  run,
  dirty,
  unavailableReason,
  waiting,
  action,
  onRefresh,
  onKeepSelection,
  onRemedy,
  feedback,
  onFeedback,
  optimization,
}: {
  draft: AssemblyDraft;
  candidate: Candidate;
  run: AssemblyRun;
  dirty: boolean;
  unavailableReason?: string;
  waiting: boolean;
  action: ReturnType<typeof useAction>;
  onRefresh: () => void;
  onKeepSelection: () => void;
  onRemedy: (remedy: Remedy) => void;
  feedback: string;
  onFeedback: (text: string) => void;
  optimization: OptimizationActions;
}) {
  const opinion = useRef<HTMLTextAreaElement>(null);
  const [recognition, setRecognition] = useState<{ feedback: string } | null>(
    null,
  );
  const [submitted, setSubmitted] = useState(false);
  const notify = useFeedback(),
    request = useRequestId(),
    infoId = useId();
  const current =
    recognition && !run.accepted
      ? {
          ...run,
          state: "accepted",
          accepted: true,
          feedback: recognition.feedback,
        }
      : run;
  const locked: TrialBlock | null = unavailableReason
    ? { message: unavailableReason }
    : null;
  const acceptBlock = locked ?? trialBlock(current, candidate);
  const publishBlock =
    locked ??
    releaseBlock(draft, candidate, current, dirty, acceptBlock, submitted);
  const notices = [
    ...new Set([acceptBlock?.message, publishBlock?.message].filter(Boolean)),
  ];
  const remedies = new Set<Remedy>();
  for (const block of [acceptBlock, publishBlock])
    if (block?.action) remedies.add(block.action);
  const path = draftPath(draft.id);
  async function accept() {
    try {
      const receipt = await factoryApi.post<{
        accepted: boolean;
        state: string;
        feedback?: string;
      }>(`${path}/runs/${encodeURIComponent(run.id)}/accept`, {
        candidateId: candidate.id,
        packageDigest: candidate.packageDigest,
        ...(run.reviewId !== undefined ? { reviewId: run.reviewId } : {}),
        feedback: feedback.trim() || undefined,
      });
      if (!receipt?.accepted || receipt.state !== "accepted")
        throw Error("尚未收到本次认可的回执，请刷新测试记录。");
      setRecognition({ feedback: receipt.feedback ?? feedback.trim() });
      onFeedback("");
      return "已认可本次测试结果。";
    } catch (error) {
      onRefresh();
      throw error;
    }
  }
  async function publish() {
    const payload = { candidateId: candidate.id, runId: run.id };
    try {
      const receipt = await factoryApi.post<{
        agentId: string;
        version: string;
        candidateId?: string;
        packageDigest?: string;
        state?: string;
        status?: string;
      }>(`${path}/publish`, {
        ...payload,
        requestId: request.forPayload(payload),
      });
      if (
        receipt?.agentId !== candidate.agentId ||
        receipt.version !== candidate.version ||
        (receipt.candidateId !== undefined &&
          receipt.candidateId !== candidate.id) ||
        (receipt.packageDigest !== undefined &&
          receipt.packageDigest !== candidate.packageDigest) ||
        !(receipt.state || receipt.status)
      )
        throw Error("尚未确认这个版本的发布登记，请刷新记录并核对版本状态。");
      setSubmitted(true);
      request.confirmed();
      return `已提交 ${candidate.agentId} v${candidate.version}，等待管理员审核。`;
    } catch (error) {
      onRefresh();
      throw error;
    }
  }
  return (
    <>
      {current.accepted && <strong>用户已认可</strong>}
      {current.feedback && <p>验收意见 · {current.feedback}</p>}
      <label className="assembly-field">
        {current.accepted ? "优化意见" : "验收意见（可选）"}
        <textarea
          ref={opinion}
          readOnly={waiting || optimization.submitting}
          maxLength={4000}
          value={feedback}
          onChange={(e) => {
            onKeepSelection();
            onFeedback(e.target.value);
          }}
        />
      </label>
      <TrialOptimization
        actions={optimization}
        draft={draft}
        candidate={candidate}
        run={run}
        dirty={dirty}
        waiting={waiting}
        feedback={feedback}
        onNeedFeedback={() => opinion.current?.focus()}
        onRestoreFeedback={onFeedback}
        onKeepSelection={onKeepSelection}
        onEditDraft={() => onRemedy("edit")}
      />
      <div id={infoId}>
        {notices.map((message) => (
          <p key={message} className="live-subtle">
            {message}
          </p>
        ))}
      </div>
      <div className="fc-actions">
        {!current.accepted && (
          <button
            type="button"
            className={acceptBlock ? "ui-action" : "ui-action ui-primary"}
            disabled={waiting || optimization.submitting}
            aria-describedby={infoId}
            onClick={() => {
              onKeepSelection();
              if (acceptBlock) notify(acceptBlock.message, "info");
              else void action.run(accept);
            }}
          >
            认可测试结果
          </button>
        )}
        <button
          type="button"
          className={publishBlock ? "ui-action" : "ui-action ui-primary"}
          disabled={waiting || optimization.submitting}
          aria-describedby={infoId}
          onClick={() => {
            onKeepSelection();
            if (publishBlock) notify(publishBlock.message, "info");
            else void action.run(publish);
          }}
        >
          提交发布审核
        </button>
        {[...remedies].map((remedy) => (
          <button
            type="button"
            key={remedy}
            className="ui-action ui-small"
            onClick={() => {
              onKeepSelection();
              onRemedy(remedy);
            }}
          >
            {remedyLabel[remedy]}
          </button>
        ))}
      </div>
    </>
  );
}
