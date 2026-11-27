import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "../../test/render";
import { AssemblyWorkspace } from "./AssemblyWorkspace";
import {
  assemblies,
  draftPath,
  emptyConfig,
  type AssemblyDraft,
} from "./assembly-model";
import { factoryApi } from "./factory-client";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "preserves a first turn after a lost response and reconciles server acceptance (%s)",
  async (accepted) => {
    const draft: AssemblyDraft = {
      id: "new-assembly",
      revision: 1,
      description: "",
      config: emptyConfig(),
      messages: [],
      operations: [],
      candidates: [],
      runs: [],
    };
    const description = "归纳每周订单";
    const question = "周报需要按团队还是按客户汇总？";
    vi.spyOn(factoryApi, "get").mockImplementation(async (path) => {
      if (path === assemblies)
        return { items: draft.description ? [structuredClone(draft)] : [] };
      if (path === assemblies + "/options")
        return {
          skills: [],
          mcpTools: [],
          capabilities: [],
          datasets: [],
          runtimeNative: { runtime: "codex", available: true },
          connection: { status: "connected" },
        };
      if (path === draftPath(draft.id)) return structuredClone(draft);
      throw Error("unexpected read " + path);
    });
    let attempts = 0;
    const post = vi
      .spyOn(factoryApi, "post")
      .mockImplementation(async (path, body) => {
        if (path === assemblies) {
          Object.assign(draft, body);
          draft.config = { ...emptyConfig(), ...draft.config };
          return structuredClone(draft);
        }
        if (path !== draftPath(draft.id) + "/suggest")
          throw Error("unexpected write " + path);
        const { message, requestId } = body as {
          message: string;
          requestId: string;
        };
        if (++attempts > 1 || accepted) {
          draft.messages.push(
            { role: "user", content: message, requestId },
            { role: "assistant", content: question, operationId: "turn-one" },
          );
        }
        if (attempts === 1) throw Error("未收到本次装配的回执");
        return { id: "turn-one", state: "completed" };
      });
    const workspace = (
      <AssemblyWorkspace
        active
        endpoint={"dialogue-retry-" + accepted}
        connection="live"
        revision={0}
        onChange={vi.fn()}
        onSettings={vi.fn()}
        onTask={vi.fn()}
        onNewTask={vi.fn()}
      />
    );
    const view = render(workspace);
    expect(
      screen.getByRole("heading", {
        name: "装配助手（描述智能体的工作内容由AI生成智能体）",
      }),
    ).toBeVisible();
    const composer = () =>
      screen.getByRole("textbox", { name: "给装配助手的消息" });
    const send = () => screen.getByRole("button", { name: "一键装配" });
    const mode = await screen.findByRole("checkbox", {
      name: "使用运行时原生能力",
    });
    expect(mode).toBeChecked();
    if (!accepted) fireEvent.click(mode);
    fireEvent.click(screen.getByRole("tab", { name: "智能体测试" }));
    fireEvent.click(screen.getByRole("tab", { name: "智能体组装" }));
    expect(mode).toHaveProperty("checked", accepted);
    fireEvent.change(screen.getByRole("textbox", { name: "智能体名称" }), {
      target: { value: "周报员" },
    });
    expect(send()).toBeDisabled();
    fireEvent.change(composer(), { target: { value: description } });
    fireEvent.click(send());
    await waitFor(() =>
      expect(screen.getByLabelText("智能体与版本")).toHaveValue(draft.id),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "未收到本次装配的回执",
    );
    if (!accepted) {
      view.unmount();
      render(workspace);
      expect(composer()).toHaveValue(description);
      await waitFor(() => expect(send()).toBeEnabled());
      fireEvent.click(send());
    }
    const log = screen.getByRole("log", { name: "装配对话" });
    expect(await within(log).findByText(question)).toBeVisible();
    expect(within(log).getAllByText(description)).toHaveLength(1);
    expect(composer()).toHaveValue("");
    expect(screen.getByLabelText("智能体名称")).toHaveValue("周报员");
    const creates = post.mock.calls.filter(([path]) => path === assemblies);
    expect(creates).toHaveLength(1);
    expect(creates[0][1]).toEqual({
      description,
      config: { displayName: "周报员", useRuntimeNative: accepted },
    });
    expect(
      screen.getByRole("checkbox", { name: "使用运行时原生能力" }),
    ).toHaveProperty("checked", accepted);
    const turns = post.mock.calls.filter(([path]) => path.endsWith("/suggest"));
    expect(turns).toHaveLength(accepted ? 1 : 2);
    expect(turns[0][1]).toEqual({
      revision: 1,
      message: description,
      generateWhenReady: true,
      requestId: expect.any(String),
    });
    expect(turns[turns.length - 1]).toEqual(turns[0]);
  },
);
