import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssemblyWorkspace } from "./AssemblyWorkspace";
import {
  assemblies,
  draftPath,
  emptyConfig,
  type AssemblyDraft,
  type AssemblyOptions,
} from "./assembly-model";
import { factoryApi } from "./factory-client";

afterEach(() => vi.restoreAllMocks());

it("shows real editable versions and keeps the editor usable after a conflict or disconnection", async () => {
  const config = {
    ...emptyConfig(),
    displayName: "采购核对",
    version: "2.3.1",
  };
  const draft: AssemblyDraft = {
    id: "quote-edit",
    revision: 37,
    description: "核对交付日",
    config,
    operations: [
      {
        id: "generated-previously",
        kind: "generate",
        state: "completed",
        message: "已封存候选源码、资源及用例。",
        createdAt: "2026-11-01T08:00:00Z",
      },
    ],
    messages: [],
    candidates: [],
    runs: [],
  };
  const unnamed = {
    ...draft,
    id: "unfinished",
    revision: 104,
    config: { ...emptyConfig(), version: "" },
  };
  const options: AssemblyOptions = {
    skills: [],
    mcpTools: [],
    capabilities: [],
    datasets: [{ id: "rules", name: "采购规则" }],
    connection: { status: "connected" },
  };
  vi.spyOn(factoryApi, "get").mockImplementation(async (path) => {
    if (path === assemblies) return { items: [draft, unnamed] };
    if (path === draftPath(draft.id)) return structuredClone(draft);
    if (path === assemblies + "/options") return options;
    throw Error("unexpected read " + path);
  });
  vi.spyOn(factoryApi, "post").mockRejectedValue(
    "草稿已有更新，请刷新后再保存。（HTTP 409）",
  );
  const props = {
    active: true,
    endpoint: "https://studio-regression.example",
    connection: "live" as const,
    revision: 0,
    onChange: vi.fn(),
    onSettings: vi.fn(),
    onTask: vi.fn(),
    onNewTask: vi.fn(),
  };
  const view = render(<AssemblyWorkspace {...props} />);
  const selector = screen.getByRole("combobox", { name: "智能体与版本" });
  expect(
    await within(selector).findByRole("option", {
      name: "采购核对 · v2.3.1 · 编辑中",
    }),
  ).toHaveValue(draft.id);
  expect(
    within(selector).getByRole("option", {
      name: "未命名智能体 · 版本号待填写 · 编辑中",
    }),
  ).toHaveValue(unnamed.id);
  expect(selector).not.toHaveTextContent(/草稿|修订|v37|v104/);
  fireEvent.change(selector, { target: { value: draft.id } });
  const goal = await screen.findByDisplayValue("核对交付日");
  const history = screen.getByText("生成与助手记录");
  expect(history.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(history);
  expect(
    screen.getByText("智能体已生成，代码、资源和测试用例已保存。"),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "基本信息" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /采购规则/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "生成智能体" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "测试智能体" })).toBeDisabled();
  expect(screen.queryByRole("link", { name: /前往测试区/ })).toBeNull();
  fireEvent.change(goal, { target: { value: "检查五月报价" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent(
    "当前版本的编辑内容已更新，请重新读取后再保存。（HTTP 409）",
  );
  expect(error).not.toHaveTextContent("草稿");
  view.rerender(<AssemblyWorkspace {...props} connection="reconnecting" />);
  expect(screen.getByText(/中台连接已中断/)).toBeVisible();
  expect(screen.getByRole("button", { name: "生成智能体" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
  expect(goal).toHaveValue("检查五月报价");
  draft.revision++;
  view.rerender(<AssemblyWorkspace {...props} revision={1} />);
  expect(
    await screen.findByRole("button", { name: "合并我的改动" }),
  ).toBeVisible();
  expect(screen.getByText(/你可以合并本地修改/)).not.toHaveTextContent(
    /修订|草稿|v38/,
  );
});
