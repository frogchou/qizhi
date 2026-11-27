import { useId, useRef, useState } from "react";
import { useFeedback } from "../../components/FeedbackNotice";
import { TrialReceipts } from "./AssemblyReceipts";
import { SampleReview, TrialAcceptance } from "./TrialAcceptance";
import type { OptimizationActions } from "./TrialOptimization";
import type { useTrialInputs } from "./trial-inputs";
import {
  FactoryAttachments,
  useFactoryAttachments,
} from "./FactoryAttachments";
import {
  Badge,
  Empty,
  Facts,
  Modal,
  ReadNotice,
  useAction,
} from "./FactoryControls";
import { factoryApi } from "./factory-client";
import { FactoryDelivery } from "./FactoryDelivery";
import { useFactoryRead } from "./factory-feed";
import {
  stateName,
  when,
  type Agent,
  type OpenTask,
  type TaskDetail,
} from "./factory-model";
import {
  generationOptions,
  assemblies,
  draftPath,
  legacyImageRequired,
  runtimeNativeLabel,
  useRequestId,
  type AssemblyDraft,
  type AssemblyOptions,
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
    (c) =>
      c.id === record.candidateId && c.packageDigest === record.packageDigest,
  );
  const run = read.data?.runs.find(
    (r) =>
      r.id === record.runId &&
      r.candidateId === record.candidateId &&
      (r.packageDigest === undefined ||
        r.packageDigest === record.packageDigest),
  );
  const options = useFactoryRead<AssemblyOptions>(
    candidate?.config.useRuntimeNative === undefined &&
      candidate?.config.nativeSkills?.length
      ? `${assemblies}/options`
      : null,
    0,
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
      {read.data && (!candidate || !run) && (
        <p className="live-subtle">
          当前记录与这次发布登记的生成编号、测试编号或包摘要未能匹配。请刷新后核对登记信息。
        </p>
      )}
      {candidate && (
        <>
          <Facts
            rows={[
              ["业务流程", candidate.config.workflow],
              ["测试环境标识", candidate.buildEnvironment],
              ["验收条件", candidate.config.criteria.join("、")],
              [
                "企业精选 Skill",
                candidate.config.skills.join("、") || "未选用",
              ],
              [
                "运行时原生能力",
                runtimeNativeLabel(
                  candidate.config,
                  options.data?.nativeSkills,
                ),
              ],
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
          <SampleReview
            run={run}
            useRuntimeNative={candidate?.config.useRuntimeNative}
            requiresImage={legacyImageRequired(candidate?.config)}
          />
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
  nativeOptions,
  revision = 0,
  forms,
  optimization,
  selectedBuild,
  onBuildChange,
  onEditDraft,
  onManageVersion,
  disabled,
  unavailableReason,
  dirty,
  onChange,
  onTask,
  onNewTask,
}: {
  draft: AssemblyDraft;
  nativeOptions?: AssemblyOptions["nativeSkills"];
  revision?: number;
  forms: ReturnType<typeof useTrialInputs>;
  optimization: OptimizationActions;
  selectedBuild?: string;
  onBuildChange: (id: string) => void;
  onEditDraft: () => void;
  onManageVersion: (agentId: string, version: string) => void;
  disabled: boolean;
  unavailableReason?: string;
  dirty: boolean;
  onChange: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
}) {
  const builds = generationOptions(draft.candidates);
  const [firstBuild] = useState(() => builds[0]?.candidate.id),
    [source, showSource] = useState(false);
  const selection = selectedBuild ?? firstBuild;
  const candidate = (
    selection
      ? builds.find((item) => item.candidate.id === selection)
      : builds[0]
  )?.candidate;
  if (!builds.length) return <Empty>还没有可测试的版本。</Empty>;
  if (!candidate)
    return (
      <div>
        <p>当前草稿中找不到所选生成记录。请刷新，或选择要查看的生成记录。</p>
        <label className="assembly-field">
          生成记录
          <select value="" onChange={(e) => onBuildChange(e.target.value)}>
            <option value="" disabled>
              选择生成记录
            </option>
            {builds.map((b) => (
              <option key={b.candidate.id} value={b.candidate.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ui-action" onClick={onChange}>
          刷新测试记录
        </button>
      </div>
    );
  return (
    <>
      <div className="studio-test-bar">
        <label className="assembly-field">
          生成记录
          <select
            aria-label="生成记录"
            disabled={optimization.submitting}
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
        <p className="live-subtle">
          此次测试使用已生成的内容。当前编辑有更新，可先生成智能体再测试最新配置。
        </p>
      )}
      {Boolean(candidate.trialConcerns?.length) && (
        <details
          className="assembly-disclosure"
          key={`trial-concerns:${candidate.id}`}
        >
          <summary>
            建议在本版测试中核对（{candidate.trialConcerns?.length}）
          </summary>
          <ul>
            {candidate.trialConcerns?.map((item, index) => (
              <li key={index}>
                <strong>{item.reason}</strong>
                <p>{item.verification}</p>
                {item.line > 0 && <small>业务源码第 {item.line} 行</small>}
              </li>
            ))}
          </ul>
        </details>
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
            ["企业精选 Skill", candidate.config.skills.join("、") || "未选用"],
            [
              "运行时原生能力",
              runtimeNativeLabel(candidate.config, nativeOptions),
            ],
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
        revision={revision}
        candidate={candidate}
        form={forms.forBuild(draft.id, candidate.id)}
        optimization={optimization}
        dirty={dirty}
        disabled={disabled}
        unavailableReason={unavailableReason}
        onEditDraft={onEditDraft}
        onCurrentBuild={() => {
          const current = builds.find(
            (b) => b.candidate.revision === draft.revision,
          );
          if (current) onBuildChange(current.candidate.id);
        }}
        onManageVersion={() =>
          onManageVersion(candidate.agentId, candidate.version)
        }
        onChange={onChange}
        onTask={onTask}
      />
    </>
  );
}
function TrialDelivery({
  taskId,
  revision,
  onTask,
}: {
  taskId: string;
  revision: number;
  onTask: OpenTask;
}) {
  const [open, setOpen] = useState(false);
  const region = useId();
  const read = useFactoryRead<TaskDetail>(
    open ? `/v1/tasks/${encodeURIComponent(taskId)}` : null,
    revision,
  );
  return (
    <div>
      <button
        type="button"
        className="ui-action ui-small"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => setOpen(!open)}
      >
        {open ? "收起测试产物" : "查看测试产物"}
      </button>
      <div id={region} hidden={!open}>
        {open && (
          <>
            <ReadNotice read={read} />
            {read.data && (
              <FactoryDelivery detail={read.data} showReview={false} />
            )}
            <button
              type="button"
              className="ui-action ui-quiet ui-small"
              onClick={() => onTask(taskId, "测试工单 " + taskId, "delivery")}
            >
              在工单中查看交付成果
            </button>
          </>
        )}
      </div>
    </div>
  );
}
function TrialForm({
  draft,
  revision,
  candidate,
  form,
  optimization,
  dirty,
  disabled,
  unavailableReason,
  onEditDraft,
  onCurrentBuild,
  onManageVersion,
  onChange,
  onTask,
}: {
  draft: AssemblyDraft;
  revision: number;
  candidate: Candidate;
  form: ReturnType<ReturnType<typeof useTrialInputs>["forBuild"]>;
  optimization: OptimizationActions;
  dirty: boolean;
  disabled: boolean;
  unavailableReason?: string;
  onEditDraft: () => void;
  onCurrentBuild: () => void;
  onManageVersion: () => void;
  onChange: () => void;
  onTask: OpenTask;
}) {
  const { goal, input, selectedRun, opinions } = form.fields;
  const selectRun = (id: string) =>
    form.update((old) => ({ ...old, selectedRun: id }));
  const goalField = useRef<HTMLTextAreaElement>(null);
  const notify = useFeedback();
  const attachments = useFactoryAttachments({
      value: form.fields.attachments,
      update: (change) =>
        form.update((old) => ({
          ...old,
          attachments: change(old.attachments),
        })),
    }),
    action = useAction(onChange),
    request = useRequestId();
  const runs = draft.runs
    .filter((r) => r.candidateId === candidate.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const run = selectedRun ? runs.find((r) => r.id === selectedRun) : runs[0];
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
              ref={goalField}
              value={goal}
              onChange={(e) => {
                const goal = e.target.value;
                form.update((old) => ({ ...old, goal }));
              }}
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
                onChange={(e) => {
                  const input = e.target.value;
                  form.update((old) => ({ ...old, input }));
                }}
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
          <div className="assembly-row">
            <h3>测试记录</h3>
            <button
              type="button"
              className="ui-action ui-quiet ui-small"
              onClick={() => {
                onChange();
                notify("正在刷新测试记录。", "info");
              }}
            >
              刷新测试记录
            </button>
          </div>
          {(runs.length > 0 || selectedRun) && (
            <label className="assembly-field">
              选择测试记录
              <select
                aria-label="选择测试记录"
                value={run?.id ?? selectedRun}
                disabled={optimization.submitting}
                onChange={(e) => selectRun(e.target.value)}
              >
                {!run && (
                  <option value={selectedRun}>等待读取 · {selectedRun}</option>
                )}
                {runs.map((r) => (
                  <option value={r.id} key={r.id}>
                    {when(r.createdAt)} · {stateName(r.state)} · {r.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {run ? (
            <>
              <div className="assembly-row">
                <Badge value={run.state} />
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
              <TrialDelivery
                key={"delivery:" + run.id}
                taskId={run.taskId}
                revision={revision}
                onTask={onTask}
              />
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
              <SampleReview
                run={run}
                useRuntimeNative={candidate.config.useRuntimeNative}
                requiresImage={legacyImageRequired(candidate.config)}
              />
              <TrialReceipts items={run.receipts} />
              <TrialAcceptance
                key={run.id}
                run={run}
                draft={draft}
                candidate={candidate}
                feedback={opinions[run.id] ?? ""}
                onFeedback={(text) =>
                  form.update((old) => ({
                    ...old,
                    selectedRun: run.id,
                    opinions: { ...old.opinions, [run.id]: text },
                  }))
                }
                optimization={optimization}
                dirty={dirty}
                unavailableReason={
                  disabled
                    ? (unavailableReason ??
                      "暂时无法提交，请刷新草稿和测试记录。")
                    : undefined
                }
                waiting={action.busy || attachments.busy}
                action={action}
                onRefresh={onChange}
                onKeepSelection={() => selectRun(run.id)}
                onRemedy={(remedy) => {
                  switch (remedy) {
                    case "edit":
                      return onEditDraft();
                    case "currentBuild":
                      return onCurrentBuild();
                    case "manage":
                      return onManageVersion();
                    case "sample":
                      return goalField.current?.focus();
                    case "review":
                      return onTask(
                        run.taskId,
                        "测试工单 " + run.taskId,
                        "quality",
                      );
                    case "plan":
                      return onTask(
                        run.taskId,
                        "测试工单 " + run.taskId,
                        "plan",
                      );
                  }
                }}
              />
            </>
          ) : (
            <p className="live-subtle">
              {selectedRun
                ? "正在读取刚提交的测试记录。可刷新查看最新进度。"
                : "这个版本还没有测试记录。请先填写样例需求并测试智能体。"}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
