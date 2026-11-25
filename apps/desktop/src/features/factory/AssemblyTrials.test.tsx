import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssemblyTrials } from "./AssemblyTrials";
import {
  emptyConfig,
  type AssemblyDraft,
  type Candidate,
} from "./assembly-model";
import { factoryApi } from "./factory-client";

afterEach(() => vi.restoreAllMocks());

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
    disabled: false,
    dirty: false,
    onChange: vi.fn(),
    onTask: vi.fn(),
    onNewTask: vi.fn(),
  };
  const send = vi
    .spyOn(factoryApi, "post")
    .mockResolvedValue({ id: "run-1", taskId: "task-1" });
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
  fireEvent.change(screen.getByRole("textbox", { name: "样例需求" }), {
    target: { value: "检查第二份报价" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试智能体" }));
  expect(await screen.findByText("已提交测试工单 task-1")).toBeVisible();
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
