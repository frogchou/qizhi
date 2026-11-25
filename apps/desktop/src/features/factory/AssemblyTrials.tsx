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
    <Modal title="候选源码与差异" onClose={onClose} wide>
      <p className="live-subtle">
        {candidate.agentId} · v{candidate.version} · 修订 {candidate.revision}
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
      {read.data && !file && <Empty>此候选没有可展示的源文件</Empty>}
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
          ["候选快照", record.candidateId],
          ["包摘要", <code>{record.packageDigest}</code>],
          ["试跑记录", record.runId],
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
              onTask(run.taskId, "发布试跑 " + run.taskId, "delivery")
            }
          >
            查看试跑工单及产物
          </button>
        </>
      )}
    </section>
  );
}

export function AssemblyTrials({
  draft,
  disabled,
  dirty,
  onChange,
  onTask,
  onNewTask,
}: {
  draft: AssemblyDraft;
  disabled: boolean;
  dirty: boolean;
  onChange: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
}) {
  const [selected, select] = useState(""),
    [source, showSource] = useState(false);
  const candidates = [...draft.candidates].sort(
    (a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt),
  );
  const candidate = candidates.find((c) => c.id === selected) ?? candidates[0];
  if (!candidate)
    return <Empty>生成候选后，可在这里检查源码、上传样例并试跑。</Empty>;
  return (
    <>
      <label className="assembly-field">
        候选快照
        <select value={candidate.id} onChange={(e) => select(e.target.value)}>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              v{c.version} · 修订 {c.revision} · {when(c.createdAt)}
            </option>
          ))}
        </select>
      </label>
      <Facts
        rows={[
          ["智能体", candidate.agentId],
          ["包摘要", <code>{candidate.packageDigest}</code>],
          ["测试环境标识", candidate.buildEnvironment],
          [
            "发布状态",
            candidate.releaseStatus
              ? stateName(candidate.releaseStatus)
              : "尚未提交审核",
          ],
        ]}
      />
      <div className="fc-actions">
        <button
          type="button"
          className="ui-action ui-small"
          onClick={() => showSource(true)}
        >
          查看源码与差异
        </button>
        {candidate.releaseStatus === "ready" && (
          <button
            type="button"
            className="ui-action ui-small"
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
      </div>
      <details className="assembly-disclosure">
        <summary>工作流程与授权范围</summary>
        <p>{candidate.config.workflow}</p>
        <Facts
          rows={[
            ["验收条件", candidate.config.criteria.join("；")],
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
      throw Error("中台未返回试跑编号，请刷新草稿查看记录。");
    request.confirmed();
    selectRun(result.id);
    return "已提交试跑工单 " + result.taskId;
  }
  return (
    <>
      <section className="assembly-section">
        <h3>样例试跑</h3>
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
          启动试跑
        </button>
      </section>
      <section className="assembly-section">
        <h3>该快照的试跑记录</h3>
        {run ? (
          <>
            <label className="assembly-field">
              试跑记录
              <select
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
                  onTask(run.taskId, "试跑工单 " + run.taskId, "plan")
                }
              >
                打开试跑工单 {run.taskId}
              </button>
            </div>
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
                  此工单缺少原候选执行成功的记录，请重新试跑。
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
                当前草稿已有修改。发布这份工作说明前，请生成并验证当前修订的新候选。
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
                  认可此次试跑
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
          <p className="live-subtle">尚未对这个候选快照试跑。</p>
        )}
      </section>
      <ActionNotice action={action} />
    </>
  );
}
