import { useState, type ComponentProps } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { render } from "../../test/render";
import { afterEach, expect, it, vi } from "vitest";
import { AssemblyTrials as Trials } from "./AssemblyTrials";
import { useTrialInputs } from "./trial-inputs";
import {
  emptyConfig,
  type AssemblyDraft,
  type Candidate,
} from "./assembly-model";
import { factoryApi } from "./factory-client";

afterEach(() => vi.restoreAllMocks());

function AssemblyTrials(
  props: Omit<ComponentProps<typeof Trials>, "forms" | "optimization">,
) {
  const forms = useTrialInputs();
  return (
    <Trials
      {...props}
      forms={forms}
      optimization={{
        focused: null,
        submitting: false,
        submit: vi.fn(),
        open: vi.fn(),
      }}
    />
  );
}

it("keeps the selected build and sample when another build has the same release version", async () => {
  const config = { ...emptyConfig(), agentId: "quote", version: "2.3.0" };
  const first: Candidate = {
    id: "quote-build-a",
    agentId: "quote",
    version: "2.3.0",
    revision: 17,
    config,
    packageDigest: "digest-a",
    createdAt: "2026-11-24T08:00:00.030Z",
  };
  const second: Candidate = {
    ...first,
    id: "quote-build-b",
    revision: 18,
    packageDigest: "digest-b",
    trialConcerns: [
      {
        line: 23,
        reason: "复核极小金额",
        verification: "输入一笔一分钱的报价。",
      },
    ],
    createdAt: "2026-11-24T08:00:00.775Z",
  };
  const draft: AssemblyDraft = {
    id: "quote-draft",
    revision: 18,
    description: "核对报价",
    config,
    candidates: [first],
    runs: [],
    messages: [],
    operations: [],
  };
  const props = {
    draft,
    onEditDraft: vi.fn(),
    disabled: false,
    dirty: false,
    onChange: vi.fn(),
    onTask: vi.fn(),
    onNewTask: vi.fn(),
  };
  const send = vi
    .spyOn(factoryApi, "post")
    .mockResolvedValueOnce({ id: "run-1", taskId: "task-1" })
    .mockResolvedValueOnce({ id: "run-2", taskId: "task-2" });
  function Harness({ draft: current }: { draft: AssemblyDraft }) {
    const [selectedBuild, onBuildChange] = useState<string>();
    return (
      <AssemblyTrials
        {...props}
        draft={current}
        selectedBuild={selectedBuild}
        onBuildChange={onBuildChange}
        onManageVersion={vi.fn()}
      />
    );
  }
  const view = render(<Harness draft={draft} />);
  const selector = screen.getByRole("combobox", { name: "生成记录" });
  expect(within(selector).getByRole("option")).toHaveTextContent(
    /2026.+v2\.3\.0/,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "样例需求" }), {
    target: { value: "检查第一份报价" },
  });
  view.rerender(<Harness draft={{ ...draft, candidates: [first, second] }} />);
  expect(selector).toHaveValue(first.id);
  expect(screen.queryByText(/建议在本版测试中核对/)).toBeNull();
  expect(within(selector).getAllByRole("option")).toHaveLength(2);
  expect(
    within(selector).getByRole("option", { name: /quote-build-b/ }),
  ).toHaveTextContent("v2.3.0");
  expect(selector).not.toHaveTextContent(/修订|v17|v18/);
  expect(screen.getByRole("textbox", { name: "样例需求" })).toHaveValue(
    "检查第一份报价",
  );
  fireEvent.click(screen.getByRole("button", { name: "测试智能体" }));
  expect(await screen.findByText("已提交测试工单 task-1")).toBeVisible();
  expect(send).toHaveBeenLastCalledWith(
    "/v1/factory/assemblies/quote-draft/runs",
    {
      candidateId: first.id,
      goal: "检查第一份报价",
      inputIds: [],
      requestId: expect.any(String),
    },
  );
  fireEvent.change(selector, { target: { value: second.id } });
  fireEvent.click(screen.getByText("建议在本版测试中核对（1）"));
  expect(screen.getByText("输入一笔一分钱的报价。")).toBeVisible();
  expect(screen.getByText("业务源码第 23 行")).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "样例需求" }), {
    target: { value: "检查第二份报价" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试智能体" }));
  expect(await screen.findByText("已提交测试工单 task-2")).toBeVisible();
  expect(send).toHaveBeenLastCalledWith(
    "/v1/factory/assemblies/quote-draft/runs",
    {
      candidateId: second.id,
      goal: "检查第二份报价",
      inputIds: [],
      requestId: expect.any(String),
    },
  );
});

const painting = {
  ...emptyConfig(),
  agentId: "ink-landscape",
  version: "1.0.0",
  criteria: ["画面能体现诗意"],
};
const candidate: Candidate = {
  id: "ink-build",
  revision: 2,
  config: painting,
  agentId: painting.agentId,
  version: painting.version,
  packageDigest: "bound-digest",
  createdAt: "2026-11-26T01:00:00Z",
};
const reviewed = {
  id: "ink-run",
  candidateId: candidate.id,
  taskId: "ink-task",
  packageDigest: candidate.packageDigest,
  accepted: false,
  state: "accepted",
  candidateCompleted: true,
  assertions: [{ name: "留白比例", required: true, passed: true }],
  criteria: [{ id: "R1", priority: "required", requirement: "画面能体现诗意" }],
  findings: [
    {
      id: "R1",
      status: "uncertain",
      reason: "需要查看交付的图片",
      evidenceIds: ["E12"],
    },
  ],
  reviewDecision: "accept",
  reviewRound: 1,
  reviewId: "round-one",
  businessReview: { status: "human_confirmed", criteriaIds: ["R1"] },
  createdAt: "2026-11-26T02:00:00Z",
};
const paintingDraft: AssemblyDraft = {
  id: "ink-draft",
  revision: 2,
  description: "按诗意画水墨画",
  config: painting,
  candidates: [candidate],
  runs: [reviewed],
  messages: [],
  operations: [],
};
const trialProps = () => ({
  draft: paintingDraft,
  disabled: false,
  dirty: false,
  onBuildChange: vi.fn(),
  onEditDraft: vi.fn(),
  onManageVersion: vi.fn(),
  onChange: vi.fn(),
  onTask: vi.fn(),
  onNewTask: vi.fn(),
});

it("records the operator's recognition after formal image review, then publishes the exact tested build", async () => {
  const props = trialProps();
  const post = vi
    .spyOn(factoryApi, "post")
    .mockResolvedValueOnce({ accepted: true, state: "accepted" })
    .mockResolvedValueOnce({
      agentId: painting.agentId,
      version: painting.version,
      state: "pending_review",
      candidateId: candidate.id,
    });
  render(<AssemblyTrials {...props} />);
  expect(screen.getByText(/第 1 轮.*人工.*通过/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("验收意见（可选）"), {
    target: { value: " 通过 " },
  });
  fireEvent.click(screen.getByRole("button", { name: "认可测试结果" }));
  expect(await screen.findByText("用户已认可")).toBeVisible();
  expect(post).toHaveBeenNthCalledWith(
    1,
    "/v1/factory/assemblies/ink-draft/runs/ink-run/accept",
    {
      feedback: "通过",
      candidateId: "ink-build",
      packageDigest: "bound-digest",
      reviewId: "round-one",
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "提交发布审核" }));
  expect(await screen.findByText(/已提交.*等待管理员审核/)).toBeVisible();
  expect(post).toHaveBeenNthCalledWith(
    2,
    "/v1/factory/assemblies/ink-draft/publish",
    {
      candidateId: "ink-build",
      runId: "ink-run",
      requestId: expect.any(String),
    },
  );
});

it("routes unconfirmed findings to the task review and keeps the chosen run and opinion during a refresh", () => {
  const props = trialProps();
  const pending = {
    ...reviewed,
    state: "awaiting_review",
    reviewDecision: null,
    businessReview: { status: "needs_review", criteriaIds: ["R1"] },
  };
  const draft = { ...paintingDraft, runs: [pending] };
  const post = vi.spyOn(factoryApi, "post");
  const view = render(<AssemblyTrials {...props} draft={draft} />);
  fireEvent.change(screen.getByLabelText("验收意见（可选）"), {
    target: { value: "通过" },
  });
  fireEvent.click(screen.getByRole("button", { name: "认可测试结果" }));
  expect(post).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "桌面提示" })).toHaveTextContent(
    "必需项待人工核实",
  );
  fireEvent.click(screen.getByRole("button", { name: "去工单人工复核" }));
  expect(props.onTask).toHaveBeenCalledWith(
    "ink-task",
    expect.any(String),
    "quality",
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新测试记录" }));
  expect(props.onChange).toHaveBeenCalled();
  const newer = {
    ...reviewed,
    id: "other-run",
    taskId: "other-task",
    createdAt: "2026-11-26T03:00:00Z",
  };
  view.rerender(
    <AssemblyTrials {...props} draft={{ ...draft, runs: [newer, reviewed] }} />,
  );
  expect(screen.getByRole("combobox", { name: "选择测试记录" })).toHaveValue(
    "ink-run",
  );
  expect(screen.getByLabelText("验收意见（可选）")).toHaveValue("通过");
});

it("names failed fixed checks and provides a repair path without submitting a recognition or release", () => {
  const props = trialProps();
  const failed = {
    ...reviewed,
    state: "failed",
    candidateCompleted: false,
    assertions: [
      {
        name: "留白比例",
        required: true,
        passed: false,
        message: "/blankRegions 不符",
      },
    ],
  };
  const post = vi.spyOn(factoryApi, "post");
  render(
    <AssemblyTrials {...props} draft={{ ...paintingDraft, runs: [failed] }} />,
  );
  fireEvent.change(screen.getByLabelText("验收意见（可选）"), {
    target: { value: "通过" },
  });
  fireEvent.click(screen.getByRole("button", { name: "认可测试结果" }));
  expect(screen.getAllByText(/留白比例.*重新生成/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "提交发布审核" }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "返回智能体组装" }));
  expect(props.onEditDraft).toHaveBeenCalled();
});

it("guides publication of a recognized run through unsaved edits, a stale build, and a bound release", () => {
  const props = trialProps();
  const recognized = { ...reviewed, accepted: true };
  const draft = { ...paintingDraft, runs: [recognized] };
  const post = vi.spyOn(factoryApi, "post");
  const view = render(
    <AssemblyTrials
      {...props}
      draft={draft}
      selectedBuild={candidate.id}
      dirty
    />,
  );
  const publish = () =>
    fireEvent.click(screen.getByRole("button", { name: "提交发布审核" }));
  publish();
  expect(screen.getByRole("region", { name: "桌面提示" })).toHaveTextContent(
    "未保存的修改",
  );
  fireEvent.click(screen.getByRole("button", { name: "返回智能体组装" }));
  expect(props.onEditDraft).toHaveBeenCalledOnce();
  const current = { ...candidate, id: "new-build", revision: 3 };
  const changed = { ...draft, revision: 3, candidates: [candidate, current] };
  view.rerender(
    <AssemblyTrials {...props} draft={changed} selectedBuild={candidate.id} />,
  );
  publish();
  fireEvent.click(
    screen.getByRole("button", { name: "切换到当前草稿的生成记录" }),
  );
  expect(props.onBuildChange).toHaveBeenCalledWith("new-build");
  const bound = {
    ...current,
    releaseStatus: "pending_review",
    publishedRunId: "different-run",
  };
  view.rerender(
    <AssemblyTrials
      {...props}
      draft={{ ...changed, candidates: [candidate, bound] }}
      selectedBuild={candidate.id}
    />,
  );
  publish();
  expect(screen.getByRole("region", { name: "桌面提示" })).toHaveTextContent(
    "已使用另一份测试结果",
  );
  fireEvent.click(screen.getByRole("button", { name: "查看发布版本" }));
  expect(props.onManageVersion).toHaveBeenCalledWith("ink-landscape", "1.0.0");
  expect(post).not.toHaveBeenCalled();
});

it("does not replace a missing generation with a different program or endorse a mismatched package", () => {
  const props = trialProps(),
    post = vi.spyOn(factoryApi, "post");
  const view = render(
    <AssemblyTrials {...props} selectedBuild="unknown-build" />,
  );
  expect(screen.getByText(/找不到所选生成记录/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "认可测试结果" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "生成记录" }), {
    target: { value: candidate.id },
  });
  expect(props.onBuildChange).toHaveBeenCalledWith(candidate.id);
  const draft = {
    ...paintingDraft,
    runs: [{ ...reviewed, packageDigest: "different-digest" }],
  };
  view.rerender(
    <AssemblyTrials {...props} draft={draft} selectedBuild={candidate.id} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "认可测试结果" }));
  expect(screen.getByRole("region", { name: "桌面提示" })).toHaveTextContent(
    "程序包不匹配",
  );
  expect(post).not.toHaveBeenCalled();
});

it("refreshes a conflicting decision and preserves the opinion for a retry on the new review round", async () => {
  const props = trialProps();
  const post = vi
    .spyOn(factoryApi, "post")
    .mockRejectedValueOnce(new Error("验收轮次已变化，请刷新测试记录后重试。"))
    .mockResolvedValueOnce({
      accepted: true,
      state: "accepted",
      feedback: "已看图",
    });
  const view = render(<AssemblyTrials {...props} />);
  fireEvent.change(screen.getByLabelText("验收意见（可选）"), {
    target: { value: "已看图" },
  });
  fireEvent.click(screen.getByRole("button", { name: "认可测试结果" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("验收轮次已变化");
  expect(props.onChange).toHaveBeenCalledOnce();
  view.rerender(
    <AssemblyTrials
      {...props}
      draft={{
        ...paintingDraft,
        runs: [{ ...reviewed, reviewId: "round-two", reviewRound: 2 }],
      }}
    />,
  );
  expect(screen.getByLabelText("验收意见（可选）")).toHaveValue("已看图");
  fireEvent.click(screen.getByRole("button", { name: "认可测试结果" }));
  expect(await screen.findByText("用户已认可")).toBeVisible();
  expect(post).toHaveBeenLastCalledWith(
    expect.stringContaining("ink-run/accept"),
    expect.objectContaining({ reviewId: "round-two", feedback: "已看图" }),
  );
});
