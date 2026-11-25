import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCatalog, Runtimes } from "./FactoryAreas";
import { ContextHelp } from "./FactoryControls";
import { FactoryTaskDetail } from "./FactoryTaskDetail";
import { factoryHelpGroups, helpFor, runtimeName } from "./factory-help";
import type { TaskDetail } from "./factory-model";

const factoryRead = vi.hoisted(() => vi.fn());
vi.mock("./factory-feed", () => ({
  readPath: (resource: string) => resource,
  useFactoryRead: factoryRead,
}));

function read(data: unknown) {
  return { data, error: "", loading: false, retry: vi.fn() };
}

function taskDetail(): TaskDetail {
  return {
    task: {
      id: "task-context-help",
      goal: "检查帮助说明",
      state: "running",
      acceptance_mode: "human_review",
      created_at: "2026-11-16T02:00:00Z",
      updated_at: "2026-11-16T02:00:00Z",
    },
    planSummary: null,
    plans: [],
    nodes: [],
    attempts: [],
    activities: [],
    artifacts: [],
    acceptanceRounds: [],
  };
}

afterEach(() => {
  factoryRead.mockReset();
});

describe("factory contextual help catalogue", () => {
  it("uses clear names for managed local services and Codex reasoning", () => {
    expect(runtimeName("native")).toBe("本地服务运行时");
    expect(runtimeName("codex")).toBe("Codex 推理运行时");
  });

  it("keeps unknown runtime values visible instead of guessing their implementation", () => {
    expect(runtimeName("pi")).toBe("pi");
  });

  it("organizes explanations into the four factory guide topics", () => {
    expect(factoryHelpGroups.map((group) => group.title)).toEqual([
      "运行时",
      "执行流程",
      "资料与交付",
      "审核与操作",
    ]);
    expect(helpFor("frozen-materials").description).toContain("资料快照");
  });

  it("shows an explanation when keyboard focus reaches the help button", () => {
    render(createElement(ContextHelp, { id: "heartbeat" }));

    const button = screen.getByRole("button", { name: "解释：心跳" });
    fireEvent.focus(button);

    expect(screen.getByRole("tooltip")).toHaveTextContent("存活信号");
  });

  it("keeps a clicked explanation open until Escape closes it", () => {
    render(createElement(ContextHelp, { id: "runtime-native" }));

    const button = screen.getByRole("button", {
      name: "解释：本地服务运行时",
    });
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    expect(screen.getByRole("tooltip")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("consumes Escape before an enclosing drawer can close", () => {
    const closeDrawer = vi.fn();
    const closeIfUnhandled = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) closeDrawer();
    };
    document.addEventListener("keydown", closeIfUnhandled);
    try {
      render(createElement(ContextHelp, { id: "runtime-native" }));
      const button = screen.getByRole("button", {
        name: "解释：本地服务运行时",
      });
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "Escape" });

      expect(closeDrawer).not.toHaveBeenCalled();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    } finally {
      document.removeEventListener("keydown", closeIfUnhandled);
    }
  });

  it("keeps a pinned explanation in control when focus moves elsewhere", () => {
    const closeDrawer = vi.fn();
    const closeIfUnhandled = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) closeDrawer();
    };
    document.addEventListener("keydown", closeIfUnhandled);
    try {
      render(
        createElement(
          "div",
          null,
          createElement(ContextHelp, { id: "runtime-native" }),
          createElement("button", { type: "button" }, "其他操作"),
        ),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "解释：本地服务运行时" }),
      );
      const other = screen.getByRole("button", { name: "其他操作" });
      fireEvent.focus(other);
      fireEvent.keyDown(other, { key: "Escape" });

      expect(closeDrawer).not.toHaveBeenCalled();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    } finally {
      document.removeEventListener("keydown", closeIfUnhandled);
    }
  });

  it("uses clear runtime labels and explainers in the agent and runtime views", () => {
    factoryRead.mockReturnValueOnce(
      read({
        items: [
          {
            id: "agent-native-1",
            agentId: "agent-native",
            version: "1.0.0",
            displayName: "知识检索",
            runtime: "native",
            status: "ready",
            createdAt: "2026-11-16T02:00:00Z",
            capabilities: [],
            runningCount: 0,
          },
        ],
        total: 1,
        offset: 0,
        limit: 20,
      }),
    );
    const { unmount } = render(
      createElement(AgentCatalog, {
        revision: 1,
        onAgent: () => undefined,
      }),
    );
    expect(screen.getByText(/本地服务运行时/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "解释：智能体版本" }),
    ).toBeVisible();
    unmount();

    factoryRead.mockReturnValueOnce(
      read({
        items: [
          {
            id: "runtime-job-1",
            instanceId: "instance-1",
            taskId: "task-1",
            goal: "制作说明",
            nodeKey: "create",
            agentId: "ppt-maker",
            agentVersion: "1.0.0",
            runtime: "codex",
            state: "leased",
            lastHeartbeatAt: "2026-11-16T02:00:00Z",
            createdAt: "2026-11-16T02:00:00Z",
            updatedAt: "2026-11-16T02:00:00Z",
            metrics: {
              available: false,
              source: null,
              cpuUsageUsec: null,
              memoryBytes: null,
              pidsCurrent: null,
              observedAt: null,
            },
          },
        ],
        total: 1,
        inventory: [
          {
            id: "native",
            name: "Native",
            readyVersionCount: 1,
            activeCount: 0,
            planningCount: 0,
            attemptCount: 1,
          },
        ],
      }),
    );
    render(
      createElement(Runtimes, {
        revision: 1,
        onTask: () => undefined,
        onAgent: () => undefined,
      }),
    );
    expect(screen.getByText("本地服务运行时")).toBeVisible();
    expect(screen.getByText("Codex 推理运行时")).toBeVisible();
    expect(screen.getByRole("button", { name: "解释：运行时" })).toBeVisible();
  });

  it("keeps the stop consequence and task explanation visible in task details", () => {
    render(
      createElement(FactoryTaskDetail, {
        detail: taskDetail(),
        tab: "plan",
        onTab: () => undefined,
        onAgent: () => undefined,
        onChange: () => undefined,
        refreshTask: () => undefined,
        stale: false,
      }),
    );
    expect(screen.getByRole("button", { name: "解释：工单" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "解释：任务编排" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "停止工单" }));
    expect(screen.getByText(/不能从停止点继续/)).toBeVisible();
  });
});
