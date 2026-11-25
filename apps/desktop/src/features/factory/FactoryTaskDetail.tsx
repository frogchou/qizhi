import { useState } from "react";
import { factoryApi } from "./factory-client";
import { FactoryDelivery } from "./FactoryDelivery";
import { FactoryInteraction } from "./FactoryInteraction";
import { ReceiptDetails } from "./AssemblyReceipts";
import { RevisionForm, type RevisionDecision } from "./FactoryRevisionForm";
import {
  ActionNotice,
  Badge,
  ContextHelp,
  Empty,
  Facts,
  Filter,
  useAction,
} from "./FactoryControls";
import {
  stateName,
  when,
  type OpenAgent,
  type TaskNode,
  type TaskDetail,
  type TaskTab,
} from "./factory-model";

const tabs: [TaskTab, string][] = [
  ["plan", "任务编排"],
  ["quality", "质检验收"],
  ["delivery", "交付成果"],
  ["monitor", "执行记录"],
];
function nodeAnswer(node: TaskNode) {
  const output = node.output?.output;
  return [output?.text, output?.answer, output?.summary, output?.message].find(
    (value) => typeof value === "string" && value.trim(),
  );
}
function Plan({ detail, onAgent }: { detail: TaskDetail; onAgent: OpenAgent }) {
  const [version, setVersion] = useState("");
  const plan =
    detail.plans.find((p) => String(p.version) === version) ??
    detail.plans.find((p) => p.version === detail.task.current_plan_version) ??
    detail.plans[0];
  const summary = plan?.plan.planner ?? detail.planSummary;
  const nodes = detail.nodes.filter((n) => !plan || n.plan_id === plan.id);
  return (
    <>
      <h3>
        需求与编排计划
        <ContextHelp id="orchestration" />
      </h3>
      {detail.plans.length > 1 && (
        <Filter
          label="计划版本"
          value={String(plan?.version ?? "")}
          onChange={setVersion}
          options={detail.plans.map((p) => [
            String(p.version),
            "v" + p.version + " · " + when(p.created_at),
          ])}
        />
      )}
      {summary?.intent && <p>{summary.intent}</p>}
      {summary?.summary && <p className="live-prose">{summary.summary}</p>}
      {summary?.mode === "direct_answer" && (
        <p className="live-subtle">中台直接答复</p>
      )}
      {summary?.deliverables?.length ? (
        <p>预期交付 · {summary.deliverables.join("、")}</p>
      ) : null}
      {summary?.risks?.length ? (
        <details>
          <summary>规划时记录的风险</summary>
          <ul>
            {summary.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {!plan && !summary && <Empty>尚无已保存的编排计划</Empty>}
      {plan && (
        <Facts
          rows={[
            ["计划版本", "v" + plan.version],
            ["计划状态", stateName(plan.state)],
            ["生成于", when(plan.created_at)],
          ]}
        />
      )}
      <h3>节点与依赖</h3>
      {nodes.map((node) => {
        const spec = plan?.plan.nodes?.find((n) => n.id === node.node_key),
          deps = node.depends_on ?? spec?.dependsOn ?? [];
        const agent = node.agent_id ?? spec?.agentId,
          version = node.agent_version ?? spec?.agentVersion;
        const attempts = detail.attempts.filter(
          (a) => a.task_node_id === node.id,
        );
        const answer = nodeAnswer(node),
          err = node.output?.error;
        return (
          <article key={node.id} className="live-card">
            <strong>{node.display_title || node.node_key}</strong>
            <Badge value={node.state} />
            <Facts
              rows={[
                ["节点", node.node_key],
                ["能力", node.capability || spec?.capability || spec?.type],
                ["依赖", deps.length ? deps.join("、") : "无前置节点"],
                [
                  "编排理由",
                  node.rationale || plan?.plan.nodeReasons?.[node.node_key],
                ],
              ]}
            />
            {agent && version && (
              <button onClick={() => onAgent(agent, version)}>
                {agent} · v{version}
              </button>
            )}
            {answer && <p className="live-prose">{answer}</p>}
            {err && (
              <p className="live-notice error">
                {typeof err === "string" ? err : err.message}
              </p>
            )}
            {attempts.length > 0 && (
              <details>
                <summary>执行尝试（{attempts.length}）</summary>
                {attempts.map((a) => (
                  <p key={a.id}>
                    第 {a.attempt_number} 次 · {stateName(a.state)}
                    <small>
                      实例 {a.instance_id} · 最近心跳{" "}
                      {when(a.last_heartbeat_at)}
                    </small>
                  </p>
                ))}
              </details>
            )}
            {node.output?.evidence?.length ? (
              <details>
                <summary>引用依据（{node.output.evidence.length}）</summary>
                {node.output.evidence.map((e, i) => (
                  <p key={i}>
                    <b>{e.title ?? e.source}</b>
                    <small>{e.source}</small>
                    {e.excerpt}
                  </p>
                ))}
              </details>
            ) : null}
          </article>
        );
      })}
      {!nodes.length && (
        <Empty>
          {summary?.mode === "direct_answer"
            ? "本次直接答复没有执行节点"
            : "尚无执行节点"}
        </Empty>
      )}
      {detail.inputs?.length ? (
        <>
          <h3>
            本单冻结的输入资料
            <ContextHelp id="frozen-materials" />
          </h3>
          {detail.inputs.map((i) => (
            <p key={i.id}>
              {i.displayName}
              <small>
                {stateName(i.sourceType)} · {when(i.createdAt)}
              </small>
            </p>
          ))}
        </>
      ) : null}
    </>
  );
}
function Quality({
  detail,
  onChange,
  stale,
}: {
  detail: TaskDetail;
  onChange: () => void;
  stale: boolean;
}) {
  const rounds = [...detail.acceptanceRounds].sort((a, b) => b.round - a.round),
    latest =
      detail.currentReviewId === undefined
        ? rounds.find(
            (r) =>
              r.revision_number === undefined ||
              r.revision_number === (detail.task.revision_number ?? 0),
          )
        : rounds.find((r) => r.id === detail.currentReviewId);
  const action = useAction(onChange),
    [submitted, setSubmitted] = useState<string | null>(null);
  const [editor, setEditor] = useState<RevisionDecision | null>(null);
  const [receipt, setReceipt] = useState("");
  const id = detail.task.id;
  const canReview =
    detail.task.state === "awaiting_review" && !latest?.decision;
  const supplement =
    latest &&
    Boolean(
      latest.assessment?.error ||
      latest.assessment?.reportedGaps?.length ||
      latest.assessment?.items?.some((i) => i.status !== "met"),
    );
  const stamp = latest?.id ?? detail.task.updated_at;
  function review(decision: "accept" | "supplement") {
    void action.run(async () => {
      await factoryApi.post(`/v1/tasks/${encodeURIComponent(id)}/review`, {
        decision,
        ...(latest ? { reviewId: latest.id } : {}),
      });
      setSubmitted(stamp);
      return decision === "accept" ? "已确认验收" : "已提交补查";
    });
  }
  return (
    <>
      <h3>
        验收记录
        <ContextHelp id="human-review" />
      </h3>
      <Facts
        rows={[
          ["验收方式", stateName(detail.task.acceptance_mode)],
          ["工单状态", stateName(detail.task.state)],
        ]}
      />
      {canReview && (
        <div className="live-confirm">
          <strong>
            {latest
              ? "第 " + latest.round + " 轮等待决定"
              : "此工单等待人工确认"}
          </strong>
          <div className="fc-actions">
            <button
              className="ui-action ui-primary"
              disabled={action.busy || stale || submitted === stamp}
              onClick={() => review("accept")}
            >
              确认验收
            </button>
            {supplement && (
              <button
                className="ui-action ui-small"
                disabled={action.busy || stale || submitted === stamp}
                onClick={() => review("supplement")}
              >
                继续补查
              </button>
            )}
            <button
              className="ui-action ui-small"
              disabled={action.busy || stale || submitted === stamp}
              onClick={() => {
                setReceipt("");
                setEditor("revise");
              }}
            >
              退回重制
            </button>
            <button
              className="ui-action ui-small"
              disabled={action.busy || stale || submitted === stamp}
              onClick={() => {
                setReceipt("");
                setEditor("amend");
              }}
            >
              补充需求
            </button>
          </div>
        </div>
      )}
      {editor && canReview && (
        <RevisionForm
          key={id + stamp + editor}
          taskId={id}
          reviewId={latest?.id ?? null}
          decision={editor}
          stale={stale}
          onClose={() => setEditor(null)}
          onSubmitted={(number) => {
            setSubmitted(stamp);
            setReceipt("已接收第 " + number + " 次修订，中台正在重新规划。");
            setEditor(null);
            onChange();
          }}
        />
      )}
      <ActionNotice action={action} />
      {receipt && (
        <p className="live-notice" role="status">
          {receipt}
        </p>
      )}
      {!!detail.revisions?.length && (
        <section className="live-section">
          <h3>
            需求修订记录
            <ContextHelp id="revision" />
          </h3>
          {[...detail.revisions].reverse().map((r) => (
            <article key={r.id} className="live-card live-revision-record">
              <strong>
                第 {r.revisionNumber} 次 · {stateName(r.decision)}
              </strong>
              <small>
                {when(r.createdAt)}
                {r.planVersion ? " · 计划 v" + r.planVersion : ""}
              </small>
              {r.message && <p>{r.message}</p>}
              {r.inputIds.length > 0 && (
                <ul>
                  {r.inputIds.map((input) => (
                    <li key={input}>
                      {detail.inputs?.find((i) => i.id === input)
                        ?.displayName ?? input}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}
      {rounds.map((r) => (
        <article key={r.id} className="live-card">
          <strong>第 {r.round} 轮验收</strong>
          <Facts
            rows={[
              ["轮次时间", when(r.created_at)],
              ["人工决定", r.decision ? stateName(r.decision) : "无人工决定"],
              ["决定时间", r.decided_at ? when(r.decided_at) : null],
            ]}
          />
          {r.assessment?.error && (
            <p className="live-notice error">{r.assessment.error}</p>
          )}
          {r.assessment?.items?.map((item) => (
            <div key={item.id} className="live-finding">
              <Badge value={item.status} />
              <b>
                {r.criteria?.find((c) => c.id === item.id)?.requirement ??
                  item.id}
              </b>
              <p>{item.reason}</p>
              {item.evidenceIds?.length ? (
                <small>证据 {item.evidenceIds.join("、")}</small>
              ) : null}
            </div>
          ))}
          {r.assessment?.reportedGaps?.length ? (
            <p>待补充 · {r.assessment.reportedGaps.join("、")}</p>
          ) : null}
          {r.assessment?.evidence?.length ? (
            <details>
              <summary>评估依据（{r.assessment.evidence.length}）</summary>
              {r.assessment.evidence.map((e) => (
                <p key={e.id}>
                  <b>
                    {e.id} · {e.source}
                  </b>
                  <small>{e.node}</small>
                  {e.text}
                </p>
              ))}
            </details>
          ) : null}
        </article>
      ))}
      {!rounds.length && <Empty>尚无逐项评估记录</Empty>}
      {detail.nodes
        .filter((n) => n.capability === "quality.define_and_verify")
        .map((n) => (
          <article key={n.id} className="live-card">
            <strong>{n.display_title || n.node_key}</strong>
            <Badge value={n.state} />
            <p>
              {typeof n.output?.output?.passed === "boolean"
                ? n.output.output.passed
                  ? "节点核验通过"
                  : "节点核验未通过"
                : "尚无节点核验结果"}
            </p>
            {n.output?.output?.summary && <p>{n.output.output.summary}</p>}
          </article>
        ))}
    </>
  );
}
function Timeline({ detail }: { detail: TaskDetail }) {
  const [max, setMax] = useState(30);
  const ordered = [...detail.activities].sort(
    (a, b) =>
      Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
      Number(b.id) - Number(a.id),
  );
  return (
    <>
      <h3>
        实例与心跳
        <ContextHelp id="execution-instance" />
        <ContextHelp id="heartbeat" />
      </h3>
      {detail.attempts.map((a) => (
        <article className="live-card" key={a.id}>
          <strong>{a.instance_id}</strong>
          <Badge value={a.state} />
          <Facts
            rows={[
              [
                "节点",
                detail.nodes.find((n) => n.id === a.task_node_id)?.node_key,
              ],
              ["第几次执行", a.attempt_number],
              ["最近心跳", when(a.last_heartbeat_at)],
              ["更新", when(a.updated_at)],
            ]}
          />
        </article>
      ))}
      {!detail.attempts.length && <Empty>尚无执行实例</Empty>}
      <AssemblyTrace detail={detail} />
      {!!detail.capabilityCalls?.length && (
        <section>
          <h3>业务能力调用</h3>
          {detail.capabilityCalls.map((call) => {
            const child = detail.nodes.find(
              (n) => n.plan_id === call.planId && n.node_key === call.childKey,
            );
            return (
              <article key={call.id} className="live-card">
                <strong>{call.capability}</strong>
                <Badge value={call.state} />
                <Facts
                  rows={[
                    ["调用节点", call.parentKey],
                    ["执行节点", call.childKey],
                    [
                      "执行智能体",
                      child?.agent_id &&
                        [child.agent_id, child.agent_version]
                          .filter(Boolean)
                          .join(" · v"),
                    ],
                    ["调用原因", call.reason],
                    ["结果说明", call.explanation],
                    ["开始", when(call.createdAt)],
                    ["结束", call.settledAt && when(call.settledAt)],
                    [
                      "耗时",
                      call.settledAt
                        ? duration(call.createdAt, call.settledAt)
                        : undefined,
                    ],
                  ]}
                />
              </article>
            );
          })}
        </section>
      )}
      <h3>执行时间线</h3>
      {ordered.slice(0, max).map((e) => (
        <article className="live-card" key={e.id}>
          <strong>{e.message}</strong>
          <small>
            {when(e.occurredAt)} · {stateName(e.source)} · {e.kind}
          </small>
          <Badge value={e.state} />
          {e.detail?.text && <pre>{e.detail.text}</pre>}
        </article>
      ))}
      {!ordered.length && <Empty>尚无执行事件</Empty>}
      {ordered.length > max && (
        <button onClick={() => setMax((n) => n + 30)}>显示更早的记录</button>
      )}
    </>
  );
}
function duration(start: string, end: string) {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1000 ? ms + " 毫秒" : (ms / 1000).toFixed(1) + " 秒";
}
function AssemblyTrace({ detail }: { detail: TaskDetail }) {
  const observations =
    detail.events?.filter(
      (e) =>
        e.payload?.stage === "assembly_turn" ||
        e.payload?.stage === "assembly_tool",
    ) ?? [];
  const finalReceipts = observations.some(
    (e) => e.payload?.stage === "assembly_tool",
  )
    ? []
    : detail.nodes.flatMap(
        (n) => n.output?.output?.assemblyVerification?.receipts ?? [],
      );
  if (!observations.length && !finalReceipts.length) return null;
  return (
    <section>
      <h3>装配执行记录</h3>
      {observations.map((e, i) => (
        <article className="live-card" key={e.id ?? i}>
          <strong>
            {e.payload!.stage === "assembly_turn"
              ? "业务步骤 " + (e.payload?.step ?? "")
              : "工具执行回执"}
          </strong>
          {e.occurred_at && <small>{when(e.occurred_at)}</small>}
          {e.payload?.stage === "assembly_turn" ? (
            <p>
              本步知识库 · {e.payload.datasetIds?.join("、") || "不用知识库"}
            </p>
          ) : (
            <ReceiptDetails item={e.payload!} />
          )}
        </article>
      ))}
      {finalReceipts.map((r, i) => (
        <article className="live-card" key={i}>
          <ReceiptDetails item={r} />
        </article>
      ))}
    </section>
  );
}
const stoppableStates = new Set([
  "received",
  "assembly_preparing",
  "checking",
  "planning",
  "planned",
  "running",
  "awaiting_user_input",
  "awaiting_review",
  "stopping",
]);
function StopTask({
  task,
  stale,
  refresh,
}: {
  task: TaskDetail["task"];
  stale: boolean;
  refresh: () => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [acknowledged, setAcknowledged] = useState(false);
  const action = useAction(refresh);
  const canStop = stoppableStates.has(task.state) && !acknowledged;
  async function stop() {
    const result = await factoryApi.post<{ state: string }>(
      `/v1/tasks/${encodeURIComponent(task.id)}/stop`,
      {},
    );
    if (result.state !== "cancelled")
      throw new Error("尚未确认停止结果，请刷新工单状态");
    setAcknowledged(true);
    setConfirm(false);
    return "中台已确认停止该工单。";
  }
  return (
    <>
      {canStop && !confirm && (
        <button
          className="ui-action ui-danger ui-small live-danger-link"
          disabled={stale || action.busy}
          type="button"
          onClick={() => setConfirm(true)}
        >
          {task.state === "stopping" ? "重试停止" : "停止工单"}
        </button>
      )}
      {canStop && confirm && (
        <section
          className="live-confirm live-danger-confirm"
          aria-label="停止工单确认"
        >
          <strong>停止「{task.goal}」？</strong>
          <small>工单 {task.id}</small>
          <p>
            中台将停止此单的规划和执行，取消待处理节点和输入请求。已记录的结果和执行历史可继续查看；停止后的节点不能从停止点继续。
            <ContextHelp id="stop-task" />
          </p>
          <div className="fc-actions">
            <button
              type="button"
              className="ui-action ui-danger ui-small"
              disabled={stale || action.busy}
              onClick={() => void action.run(stop)}
            >
              确认停止工单
            </button>
            <button
              type="button"
              className="ui-action ui-quiet ui-small"
              disabled={action.busy}
              onClick={() => setConfirm(false)}
            >
              取消
            </button>
          </div>
        </section>
      )}
      <ActionNotice action={action} />
      {action.error && (
        <button className="ui-action ui-small" type="button" onClick={refresh}>
          刷新工单状态
        </button>
      )}
    </>
  );
}
export function FactoryTaskDetail({
  detail,
  tab,
  onTab,
  onAgent,
  onChange,
  refreshTask,
  stale,
}: {
  detail: TaskDetail;
  tab: TaskTab;
  onTab: (tab: TaskTab) => void;
  refreshTask: () => void;
  onAgent: OpenAgent;
  onChange: () => void;
  stale: boolean;
}) {
  const task = detail.task;
  return (
    <>
      <span className="live-task-status">
        <Badge value={task.state} />
        <ContextHelp id="task" />
      </span>
      <Facts
        rows={[
          ["工单号", task.id],
          ["需求来源", stateName(task.source_system ?? "unknown")],
          ["提交时间", when(task.created_at)],
          ["更新时间", when(task.updated_at)],
          [
            "授权知识库",
            task.authorized_dataset_ids?.join("、") ||
              (task.authorized_dataset_ids ? "不用知识库" : undefined),
          ],
          ["授权业务能力", task.authorized_capabilities?.join("、")],
          ["授权工具", task.authorized_mcp_tools?.join("、")],
        ]}
      />
      <StopTask key={task.id} task={task} stale={stale} refresh={refreshTask} />
      {detail.interactions
        ?.filter((i) => i.state === "pending")
        .map((q) => (
          <FactoryInteraction
            key={q.id}
            taskId={task.id}
            question={q}
            stale={stale}
            onChange={refreshTask}
          />
        ))}
      <nav className="live-tabs" aria-label="工单详情">
        {tabs.map(([id, name]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tab === id}
            onClick={() => onTab(id)}
          >
            {name}
          </button>
        ))}
      </nav>
      {tab === "plan" ? (
        <Plan detail={detail} onAgent={onAgent} />
      ) : tab === "quality" ? (
        <Quality detail={detail} onChange={onChange} stale={stale} />
      ) : tab === "delivery" ? (
        <FactoryDelivery detail={detail} />
      ) : (
        <Timeline detail={detail} />
      )}
    </>
  );
}
