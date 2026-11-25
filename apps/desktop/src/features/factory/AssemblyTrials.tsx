import { useState } from "react";
import { TrialReceipts } from "./AssemblyReceipts";
import {
  FactoryAttachments,
  useFactoryAttachments,
} from "./FactoryAttachments";
import {
  ActionNotice,
  Badge,
  Empty,
  Facts,
  Modal,
  ReadNotice,
  useAction,
} from "./FactoryControls";
import { factoryApi } from "./factory-client";
import { useFactoryRead } from "./factory-feed";
import { stateName, when, type Agent, type OpenTask } from "./factory-model";
import {
  canAccept,
  generationOptions,
  requiredChecksPassed,
  draftPath,
  useRequestId,
  type AssemblyDraft,
  type Candidate,
  type CandidateSource,
  type TaskScope,
} from "./assembly-model";

function SourceViewer({
  draftId,
  candidate,
  onClose,
}: {
  draftId: string;
  candidate: Candidate;
  onClose: () => void;
}) {
  const read = useFactoryRead<CandidateSource>(
    `${draftPath(draftId)}/candidates/${encodeURIComponent(candidate.id)}/source`,
    0,
  );
  const [path, setPath] = useState(""),
    [compare, setCompare] = useState(false);
  const file =
    read.data?.files.find((f) => f.path === path) ?? read.data?.files[0];
  return (
    <Modal title="生成源码与差异" onClose={onClose} wide>
      <p className="live-subtle">
        {candidate.agentId} · v{candidate.version} · {when(candidate.createdAt)}{" "}
        生成
      </p>
      <ReadNotice read={read} />
      {file && (
        <>
          <label className="assembly-field">
            文件
            <select value={file.path} onChange={(e) => setPath(e.target.value)}>
              {read.data!.files.map((f) => (
                <option key={f.path}>{f.path}</option>
              ))}
            </select>
          </label>
          <nav className="live-tabs" aria-label="源码查看方式">
            <button aria-pressed={!compare} onClick={() => setCompare(false)}>
              当前源码
            </button>
            <button aria-pressed={compare} onClick={() => setCompare(true)}>
              版本差异
            </button>
          </nav>
          {!compare ? (
            <pre className="assembly-code">{file.content}</pre>
          ) : (
            <SourceDifference
              previous={file.previousContent}
              current={file.content}
            />
          )}
        </>
      )}
      {read.data && !file && <Empty>这次生成没有可展示的源文件</Empty>}
    </Modal>
  );
}
function SourceDifference({
  previous,
  current,
}: {
  previous?: string | null;
  current: string;
}) {
  if (previous === current)
    return <p className="live-notice">文件内容与上一版相同。</p>;
  const before = previous?.split("\n") ?? [],
    after = current.split("\n");
  let from = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (from < endBefore && from < endAfter && before[from] === after[from])
    from++;
  while (
    endBefore > from &&
    endAfter > from &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  return (
    <div className="assembly-diff">
      <section>
        <h3>更改前</h3>
        <pre className="assembly-code">
          {previous == null
            ? "新增文件"
            : before
                .slice(from, endBefore)
                .map((line, i) => `${from + i + 1} − ${line}`)
                .join("\n") || "此处无原文"}
        </pre>
      </section>
      <section>
        <h3>更改后</h3>
        <pre className="assembly-code">
          {after
            .slice(from, endAfter)
            .map((line, i) => `${from + i + 1} + ${line}`)
            .join("\n") || "此处已移除"}
        </pre>
      </section>
    </div>
  );
}
export function AssemblyReview({
  record,
  onTask,
}: {
  record: NonNullable<Agent["assembly"]>;
  onTask: OpenTask;
}) {
  const read = useFactoryRead<AssemblyDraft>(draftPath(record.draftId), 0),
    [show, setShow] = useState(false);
  const candidate = read.data?.candidates.find(
    (c) => c.id === record.candidateId,
  );
  const run = read.data?.runs.find(
    (r) => r.id === record.runId && r.candidateId === record.candidateId,
  );
  return (
    <section className="assembly-section">
      <h3>发布依据</h3>
      <ReadNotice read={read} />
      <Facts
        rows={[
          ["生成记录", record.candidateId],
          ["包摘要", <code>{record.packageDigest}</code>],
          ["测试记录", record.runId],
        ]}
      />
      {candidate && (
        <>
          <Facts
            rows={[
              ["业务流程", candidate.config.workflow],
              ["测试环境标识", candidate.buildEnvironment],
              ["验收条件", candidate.config.criteria.join("、")],
              ["Skill", candidate.config.skills.join("、") || "未选用"],
              ["MCP 工具", candidate.config.mcpTools.join("、") || "未选用"],
              [
                "知识库",
                candidate.config.datasetIds.join("、") || "不用知识库",
              ],
              [
                "业务能力",
                candidate.config.capabilities.join("、") || "未选用",
              ],
            ]}
          />
          <button
            className="ui-action ui-small"
            type="button"
            onClick={() => setShow(true)}
          >
            检查发布源码与差异
          </button>
          {show && (
            <SourceViewer
              candidate={candidate}
              draftId={record.draftId}
              onClose={() => setShow(false)}
            />
          )}
        </>
      )}
      {run && (
        <>
          <p>
            {run.accepted ? "样例已获用户认可" : "样例尚待认可"}
            {run.feedback && " · " + run.feedback}
          </p>
          <ul>
            {run.assertions.map((a, i) => (
              <li key={i}>
                {a.name} · {a.required ? "必需" : "参考"} ·{" "}
                {a.passed ? "通过" : "未通过"} {a.message}
              </li>
            ))}
          </ul>
          <TrialReceipts items={run.receipts} />
          <button
            type="button"
            className="ui-action ui-small"
            onClick={() =>
              onTask(run.taskId, "发布测试 " + run.taskId, "delivery")
            }
          >
            查看测试工单及产物
          </button>
        </>
      )}
    </section>
  );
}

export function AssemblyTrials({
  draft,
  selectedBuild,
  onBuildChange,
  onManageVersion,
  disabled,
  dirty,
  onChange,
  onTask,
  onNewTask,
}: {
  draft: AssemblyDraft;
  selectedBuild?: string;
  onBuildChange: (id: string) => void;
  onManageVersion: (agentId: string, version: string) => void;
  disabled: boolean;
  dirty: boolean;
  onChange: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
}) {
  const builds = generationOptions(draft.candidates);
  const [firstBuild] = useState(() => builds[0]?.candidate.id),
    [source, showSource] = useState(false);
  const candidate = (
    builds.find(
      (item) => item.candidate.id === (selectedBuild ?? firstBuild),
    ) ?? builds[0]
  )?.candidate;
  if (!candidate) return <Empty>还没有可测试的版本。</Empty>;
  return (
    <>
      <div className="studio-test-bar">
        <label className="assembly-field">
          生成记录
          <select
            aria-label="生成记录"
            value={candidate.id}
            onChange={(e) => onBuildChange(e.target.value)}
          >
            {builds.map(({ candidate: item, label }) => (
              <option key={item.id} value={item.id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="studio-version-status">
          {candidate.releaseStatus
            ? stateName(candidate.releaseStatus)
            : "尚未提交发布审核"}
        </span>
        <div className="studio-actions">
          <button
            type="button"
            className="ui-action"
            onClick={() => showSource(true)}
          >
            查看源码与差异
          </button>
          {candidate.releaseStatus === "ready" && (
            <button
              type="button"
              className="ui-action"
              disabled={disabled}
              onClick={() =>
                onNewTask({
                  capabilities: [
                    ...new Set([
                      candidate.config.capability,
                      ...candidate.config.capabilities,
                    ]),
                  ],
                  datasetIds: candidate.config.datasetIds,
                  mcpTools: candidate.config.mcpTools,
                })
              }
            >
              用此版本新建需求
            </button>
          )}
          {candidate.releaseStatus && (
            <button
              type="button"
              className="ui-action"
              onClick={() =>
                onManageVersion(candidate.agentId, candidate.version)
              }
            >
              管理此版本
            </button>
          )}
        </div>
      </div>
      {(dirty || draft.revision !== candidate.revision) && (
        <p className="live-notice">
          此次测试使用已生成的内容。当前编辑有更新，可先生成智能体再测试最新配置。
        </p>
      )}
      <details className="assembly-disclosure">
        <summary>工作流程与授权范围</summary>
        <p>{candidate.config.workflow}</p>
        <Facts
          rows={[
            ["智能体", candidate.agentId],
            ["生成时间", when(candidate.createdAt)],
            ["包摘要", <code>{candidate.packageDigest}</code>],
            ["测试环境标识", candidate.buildEnvironment],
            ["验收条件", candidate.config.criteria.join("、")],
            ["Skill", candidate.config.skills.join("、") || "未选用"],
            ["工具", candidate.config.mcpTools.join("、") || "未选用"],
            ["知识库", candidate.config.datasetIds.join("、") || "不用知识库"],
            ["业务能力", candidate.config.capabilities.join("、") || "未选用"],
          ]}
        />
      </details>
      {source && (
        <SourceViewer
          draftId={draft.id}
          candidate={candidate}
          onClose={() => showSource(false)}
        />
      )}
      <TrialForm
        key={candidate.id}
        draft={draft}
        candidate={candidate}
        dirty={dirty}
        disabled={disabled}
        onChange={onChange}
        onTask={onTask}
      />
    </>
  );
}
function TrialForm({
  draft,
  candidate,
  dirty,
  disabled,
  onChange,
  onTask,
}: {
  draft: AssemblyDraft;
  candidate: Candidate;
  dirty: boolean;
  disabled: boolean;
  onChange: () => void;
  onTask: OpenTask;
}) {
  const [goal, setGoal] = useState(""),
    [input, setInput] = useState(""),
    [selectedRun, selectRun] = useState(""),
    [feedback, setFeedback] = useState("");
  const attachments = useFactoryAttachments(),
    action = useAction(onChange),
    request = useRequestId();
  const runs = draft.runs
    .filter((r) => r.candidateId === candidate.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const run = runs.find((r) => r.id === selectedRun) ?? runs[0];
  const busy = disabled || action.busy || attachments.busy;
  async function start() {
    let structured: unknown;
    if (input.trim()) {
      try {
        structured = JSON.parse(input);
      } catch {
        throw Error("结构化样例需要有效的 JSON 对象。");
      }
      if (
        !structured ||
        typeof structured !== "object" ||
        Array.isArray(structured)
      )
        throw Error("结构化样例需要有效的 JSON 对象。");
    }
    const inputIds = await attachments.resolveIds();
    const body = {
      candidateId: candidate.id,
      goal: goal.trim(),
      inputIds,
      ...(structured ? { input: structured } : {}),
    };
    const result = await factoryApi.post<{ id: string; taskId: string }>(
      `${draftPath(draft.id)}/runs`,
      { ...body, requestId: request.forPayload(body) },
    );
    if (!result.id || !result.taskId)
      throw Error("尚未收到测试工单号，请核对本次生成的测试记录。");
    request.confirmed();
    selectRun(result.id);
    return "已提交测试工单 " + result.taskId;
  }
  return (
    <>
      <div className="studio-trial-columns">
        <section className="assembly-section">
          <h3>测试样例</h3>
          <label className="assembly-field">
            样例需求
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="说明输入、期望产物和需要验证的行为"
            />
          </label>
          <FactoryAttachments attachments={attachments} disabled={busy} />
          <details className="assembly-disclosure">
            <summary>结构化样例（可选）</summary>
            <label className="assembly-field">
              输入 JSON
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="{}"
              />
            </label>
          </details>
          <button
            type="button"
            className="ui-action ui-primary"
            disabled={
              busy || !goal.trim() || Boolean(attachments.failures.length)
            }
            onClick={() => void action.run(start)}
          >
            测试智能体
          </button>
        </section>
        <section className="assembly-section">
          <h3>测试记录</h3>
          {run ? (
            <>
              <label className="assembly-field">
                选择测试记录
                <select
                  aria-label="选择测试记录"
                  value={run.id}
                  onChange={(e) => {
                    selectRun(e.target.value);
                    setFeedback("");
                  }}
                >
                  {runs.map((r) => (
                    <option value={r.id} key={r.id}>
                      {when(r.createdAt)} · {stateName(r.state)} · {r.id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="assembly-row">
                <Badge value={run.state} />
                {run.accepted && <strong>用户已认可</strong>}
                <button
                  type="button"
                  className="ui-action ui-small"
                  onClick={() =>
                    onTask(run.taskId, "测试工单 " + run.taskId, "plan")
                  }
                >
                  打开测试工单 {run.taskId}
                </button>
              </div>
              <button
                type="button"
                className="ui-action ui-quiet ui-small"
                onClick={() =>
                  onTask(run.taskId, "测试工单 " + run.taskId, "delivery")
                }
              >
                查看测试产物
              </button>
              <h4>自动断言</h4>
              {run.assertions.length ? (
                <ul className="assembly-assertions">
                  {run.assertions.map((a, i) => (
                    <li key={i}>
                      <strong>{a.name}</strong>
                      <span>
                        {a.required ? "必需" : "参考"} ·{" "}
                        {a.passed ? "通过" : "未通过"}
                      </span>
                      {a.message && <small>{a.message}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="live-subtle">中台尚未返回断言记录。</p>
              )}
              <h4>样例验收条件</h4>
              {run.candidateCompleted === false &&
                ["awaiting_review", "accepted"].includes(run.state) && (
                  <p className="live-notice">
                    此工单缺少所选版本执行成功的记录，请重新测试。
                  </p>
                )}
              {run.criteria?.length ? (
                <ul className="assembly-assertions">
                  {run.criteria.map((c) => {
                    const f = run.findings?.find((v) => v.id === c.id);
                    return (
                      <li key={c.id}>
                        <strong>{c.requirement}</strong>
                        <span>
                          {c.priority === "required" ? "必需" : "参考"} ·{" "}
                          {stateName(f?.status)}
                        </span>
                        {f?.reason && <small>{f.reason}</small>}
                        {Boolean(f?.evidenceIds?.length) && (
                          <small>依据 {f!.evidenceIds!.join("、")}</small>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="live-subtle">工单尚未给出逐项验收结果。</p>
              )}
              {(dirty || draft.revision !== candidate.revision) && (
                <p className="live-notice">
                  当前编辑内容已有修改。请重新生成并测试后再提交发布审核。
                </p>
              )}
              <TrialReceipts items={run.receipts} />
              {run.feedback && <p>验收意见 · {run.feedback}</p>}
              {!run.accepted && (
                <label className="assembly-field">
                  验收意见（可选）
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                  />
                </label>
              )}
              <div className="fc-actions">
                {!run.accepted && (
                  <button
                    type="button"
                    className="ui-action ui-primary"
                    disabled={busy || !canAccept(run)}
                    onClick={() =>
                      void action.run(async () => {
                        await factoryApi.post(
                          `${draftPath(draft.id)}/runs/${encodeURIComponent(run.id)}/accept`,
                          { feedback: feedback.trim() || undefined },
                        );
                        return "已记录对该样例的认可。";
                      })
                    }
                  >
                    认可测试结果
                  </button>
                )}
                <button
                  type="button"
                  className="ui-action ui-primary"
                  disabled={
                    busy ||
                    dirty ||
                    draft.revision !== candidate.revision ||
                    !run.accepted ||
                    Boolean(candidate.releaseStatus) ||
                    !requiredChecksPassed(run)
                  }
                  onClick={() =>
                    void action.run(async () => {
                      const payload = {
                        candidateId: candidate.id,
                        runId: run.id,
                      };
                      await factoryApi.post(`${draftPath(draft.id)}/publish`, {
                        ...payload,
                        requestId: request.forPayload(payload),
                      });
                      request.confirmed();
                      return `已提交 ${candidate.agentId} v${candidate.version}，等待管理员审核。`;
                    })
                  }
                >
                  提交发布审核
                </button>
              </div>
            </>
          ) : (
            <p className="live-subtle">这个版本还没有测试记录。</p>
          )}
        </section>
      </div>
      <ActionNotice action={action} />
    </>
  );
}
