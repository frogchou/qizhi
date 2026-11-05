import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  unavailableCommands,
  type CodexConversationHistory,
  type QizhiCommands,
} from "../../lib/tauri";
import { CodexPage } from "./CodexPage";
import { CodexConversation } from "./CodexConversation";

const project = {
  id: "project-1",
  name: "年度报告",
  goal: "整理资料",
  rootPath: "managed",
  status: "active",
  createdAtUtcMs: 1,
  updatedAtUtcMs: 1,
  lastOpenedAtUtcMs: 1,
};
const conversation = {
  id: "conversation-1",
  projectId: project.id,
  title: "起草报告",
  codexThreadId: null,
  codexSessionId: null,
  status: "draft",
  createdAtUtcMs: 1,
  updatedAtUtcMs: 1,
  archivedAtUtcMs: null,
};
const history: CodexConversationHistory = { conversation, turns: [] };
const pendingHandoff = {
  handoff: {
    id: "handoff-1",
    requestId: "request-1",
    sourceKind: "today",
    projectId: project.id,
    conversationId: conversation.id,
    status: "ready",
    createdAtUtcMs: 2,
    consumedAtUtcMs: null,
    errorSummary: null,
  },
  items: [
    {
      id: "item-1",
      handoffId: "handoff-1",
      materialId: "material-1",
      materialVersionId: "version-1",
      displayName: "年度经营计划.docx",
      sourceMetadataJson: "{}",
      displayOrder: 0,
      state: "ready",
    },
  ],
};

function commands(): QizhiCommands {
  return {
    ...unavailableCommands,
    listCodexProjects: vi.fn().mockResolvedValue([project]),
    listCodexConversations: vi.fn().mockResolvedValue([conversation]),
    readCodexConversation: vi.fn().mockResolvedValue(history),
    listCodexMaterials: vi.fn().mockResolvedValue([]),
    inspectCodexMaterialSources: vi.fn().mockResolvedValue([]),
    listCodexArtifacts: vi.fn().mockResolvedValue([]),
    listPendingCodexHandoffs: vi.fn().mockResolvedValue([]),
    startCodexTurn: vi.fn().mockImplementation(async (_input, onEvent) => {
      onEvent({
        type: "messageDelta",
        localTurnId: "local-1",
        delta: "已生成报告",
      });
      return {
        localTurnId: "local-1",
        codexTurnId: "turn-1",
        threadId: "thread-1",
      };
    }),
  };
}

describe("CodexPage", () => {
  it("shows persistent project, conversation and context columns", async () => {
    const { container, rerender } = render(<CodexPage commands={commands()} />);
    expect((await screen.findAllByText("年度报告")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("起草报告")).length).toBeGreaterThan(0);
    expect(screen.getByText(/项目资料/)).toBeInTheDocument();
    rerender(<CodexPage commands={commands()} hidden />);
    expect(container.querySelector(".codex-page")).toHaveAttribute("hidden");
  });

  it("sends on Enter and streams the Codex answer", async () => {
    const client = commands();
    render(<CodexPage commands={client} />);
    const composer = await screen.findByPlaceholderText(/Enter 发送/);
    fireEvent.change(composer, { target: { value: "请起草报告" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
    expect(await screen.findByText("请起草报告")).toBeInTheDocument();
    expect(await screen.findByText("已生成报告")).toBeInTheDocument();
    await waitFor(() => expect(client.startCodexTurn).toHaveBeenCalled());
  });

  it("keeps received materials attached to the destination conversation and consumes them with the next turn", async () => {
    const client = commands();
    client.listPendingCodexHandoffs = vi
      .fn()
      .mockResolvedValue([pendingHandoff]);
    client.dismissCodexHandoffItem = vi.fn().mockResolvedValue(undefined);
    render(
      <CodexPage
        commands={client}
        navigationTarget={{
          projectId: project.id,
          conversationId: conversation.id,
          handoffId: pendingHandoff.handoff.id,
          nonce: 7,
        }}
      />,
    );

    expect(await screen.findByText("年度经营计划.docx")).toBeInTheDocument();
    const composer = screen.getByPlaceholderText(/Enter 发送/);
    fireEvent.change(composer, { target: { value: "据此整理计划" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    await waitFor(() =>
      expect(client.startCodexTurn).toHaveBeenCalledWith(
        expect.objectContaining({ handoffIds: ["handoff-1"] }),
        expect.any(Function),
      ),
    );
  });

  it("keeps the explicit handoff destination when project loading finishes later", async () => {
    const targetProject = { ...project, id: "project-2", name: "目标项目" };
    const firstConversation = {
      ...conversation,
      id: "conversation-first",
      projectId: targetProject.id,
      title: "较早会话",
    };
    const targetConversation = {
      ...conversation,
      id: "conversation-target",
      projectId: targetProject.id,
      title: "目标会话",
    };
    const client = commands();
    client.listCodexProjects = vi
      .fn()
      .mockResolvedValue([project, targetProject]);
    client.listCodexConversations = vi
      .fn()
      .mockImplementation(async (id) =>
        id === targetProject.id
          ? [firstConversation, targetConversation]
          : [conversation],
      );
    client.readCodexConversation = vi.fn().mockImplementation(async (id) => ({
      conversation:
        id === targetConversation.id ? targetConversation : conversation,
      turns: [],
    }));
    render(
      <CodexPage
        commands={client}
        navigationTarget={{
          projectId: targetProject.id,
          conversationId: targetConversation.id,
          handoffId: "handoff-target",
          nonce: 9,
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "目标会话" }),
    ).toBeInTheDocument();
  });

  it("reloads pending materials when the same conversation receives another handoff", async () => {
    const client = commands();
    let delivered = false;
    client.listPendingCodexHandoffs = vi
      .fn()
      .mockImplementation(async () => (delivered ? [pendingHandoff] : []));
    const { rerender } = render(
      <CodexPage
        commands={client}
        navigationTarget={{
          projectId: project.id,
          conversationId: conversation.id,
          handoffId: "first-handoff",
          nonce: 21,
        }}
      />,
    );
    await waitFor(() =>
      expect(client.listPendingCodexHandoffs).toHaveBeenCalled(),
    );

    delivered = true;
    rerender(
      <CodexPage
        commands={client}
        navigationTarget={{
          projectId: project.id,
          conversationId: conversation.id,
          handoffId: pendingHandoff.handoff.id,
          nonce: 22,
        }}
      />,
    );

    expect(await screen.findByText("年度经营计划.docx")).toBeInTheDocument();
  });

  it("dismisses only the selected pending material", async () => {
    const client = commands();
    client.listPendingCodexHandoffs = vi
      .fn()
      .mockResolvedValueOnce([pendingHandoff])
      .mockResolvedValue([]);
    client.dismissCodexHandoffItem = vi.fn().mockResolvedValue(undefined);
    render(<CodexPage commands={client} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "移除待用资料 年度经营计划.docx",
      }),
    );
    await waitFor(() =>
      expect(client.dismissCodexHandoffItem).toHaveBeenCalledWith({
        handoffId: "handoff-1",
        materialId: "material-1",
      }),
    );
  });

  it("edits a previous user message by putting it back in the composer", async () => {
    const conversationHistory: CodexConversationHistory = {
      conversation,
      turns: [
        {
          id: "turn-local-1",
          conversationId: conversation.id,
          codexTurnId: "turn-1",
          userText: "整理这份材料",
          status: "completed",
          startedAtUtcMs: 1,
          completedAtUtcMs: 2,
          errorSummary: null,
          messages: [
            {
              id: "message-user",
              turnId: "turn-local-1",
              role: "user",
              markdown: "整理这份材料",
              status: "completed",
              createdAtUtcMs: 1,
            },
            {
              id: "message-assistant",
              turnId: "turn-local-1",
              role: "assistant",
              markdown: "已经整理完成。",
              status: "completed",
              createdAtUtcMs: 2,
            },
          ],
          processItems: [],
        },
      ],
    };
    render(
      <CodexConversation
        history={conversationHistory}
        livePrompt=""
        liveAnswer=""
        events={[]}
        running={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onResolveApproval={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑用户消息" }));
    expect(screen.getByPlaceholderText(/Enter 发送/)).toHaveValue(
      "整理这份材料",
    );
    expect(screen.getByText("已经整理完成。")).toBeInTheDocument();
  });

  it("keeps an in-flight turn attached to its own conversation when browsing another one", async () => {
    const second = {
      ...conversation,
      id: "conversation-2",
      title: "另一个会话",
    };
    const client: QizhiCommands = {
      ...commands(),
      listCodexConversations: vi.fn().mockResolvedValue([conversation, second]),
      readCodexConversation: vi.fn().mockImplementation(async (id: string) => ({
        conversation: id === second.id ? second : conversation,
        turns: [],
      })),
      startCodexTurn: vi.fn().mockResolvedValue({
        localTurnId: "local-running",
        codexTurnId: "turn-running",
        threadId: "thread-running",
      }),
    };
    render(<CodexPage commands={client} />);
    const composer = await screen.findByPlaceholderText(/Enter 发送/);
    fireEvent.change(composer, { target: { value: "只属于第一个会话" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });
    expect(await screen.findByText("只属于第一个会话")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("另一个会话"));
    await waitFor(() =>
      expect(screen.queryByText("只属于第一个会话")).not.toBeInTheDocument(),
    );
  });

  it("explains that local Codex must be installed instead of pretending it is ready", async () => {
    const client = commands();
    client.getCodexStatus = vi.fn().mockResolvedValue({
      installation: "missing",
      version: null,
      account: "unknown",
      sandbox: "unknown",
      server: "unavailable",
    });
    render(<CodexPage commands={client} />);

    expect(
      await screen.findByText(/未检测到本机 Codex，请先安装/),
    ).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText(/安装并登录 Codex/),
    ).toBeDisabled();
  });

  it("renames projects from the project sidebar", async () => {
    const client = commands();
    client.renameCodexProject = vi.fn().mockResolvedValue(undefined);
    render(<CodexPage commands={client} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "项目操作 年度报告" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "重命名项目 年度报告" }),
    );
    const input = screen.getByLabelText("新名称");
    fireEvent.change(input, { target: { value: "2026 年度报告" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));

    await waitFor(() =>
      expect(client.renameCodexProject).toHaveBeenCalledWith({
        id: project.id,
        name: "2026 年度报告",
      }),
    );
  });

  it("safely deletes the selected project and selects the next workspace", async () => {
    const nextProject = {
      ...project,
      id: "project-2",
      name: "客户方案",
      goal: "整理客户资料",
    };
    const nextConversation = {
      ...conversation,
      id: "conversation-2",
      projectId: nextProject.id,
      title: "方案讨论",
    };
    const client = commands();
    client.listCodexProjects = vi
      .fn()
      .mockResolvedValue([project, nextProject]);
    client.listCodexConversations = vi
      .fn()
      .mockImplementation(async (id) =>
        id === nextProject.id ? [nextConversation] : [conversation],
      );
    client.readCodexConversation = vi.fn().mockImplementation(async (id) => ({
      conversation:
        id === nextConversation.id ? nextConversation : conversation,
      turns: [],
    }));
    client.archiveCodexProject = vi.fn().mockResolvedValue(undefined);
    render(<CodexPage commands={client} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "项目操作 年度报告" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "删除项目 年度报告" }),
    );
    expect(
      screen.getByRole("dialog", { name: "删除 Codex 项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除项目" }));

    await waitFor(() =>
      expect(client.archiveCodexProject).toHaveBeenCalledWith(project.id),
    );
    expect(
      await screen.findByRole("heading", { name: "方案讨论" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("年度报告")).not.toBeInTheDocument();
  });

  it("safely deletes the selected conversation and selects the next one", async () => {
    const nextConversation = {
      ...conversation,
      id: "conversation-2",
      title: "补充材料",
    };
    const client = commands();
    client.listCodexConversations = vi
      .fn()
      .mockResolvedValue([conversation, nextConversation]);
    client.readCodexConversation = vi.fn().mockImplementation(async (id) => ({
      conversation:
        id === nextConversation.id ? nextConversation : conversation,
      turns: [],
    }));
    client.archiveCodexConversation = vi.fn().mockResolvedValue(undefined);
    render(<CodexPage commands={client} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "会话操作 起草报告" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "删除会话 起草报告" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认删除会话" }));

    await waitFor(() =>
      expect(client.archiveCodexConversation).toHaveBeenCalledWith(
        conversation.id,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "补充材料" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("起草报告")).not.toBeInTheDocument();
  });

  it("cancels deletion without archiving the project", async () => {
    const client = commands();
    client.archiveCodexProject = vi.fn().mockResolvedValue(undefined);
    render(<CodexPage commands={client} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "项目操作 年度报告" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "删除项目 年度报告" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消删除" }));

    expect(client.archiveCodexProject).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "删除 Codex 项目" }),
    ).not.toBeInTheDocument();
  });

  it("disables deletion while the project has a running turn", async () => {
    const runningProject = { ...project, status: "running" };
    const client = commands();
    client.listCodexProjects = vi.fn().mockResolvedValue([runningProject]);
    client.archiveCodexProject = vi.fn().mockResolvedValue(undefined);
    render(<CodexPage commands={client} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "项目操作 年度报告" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "删除项目 年度报告" }),
    ).toBeDisabled();
    expect(client.archiveCodexProject).not.toHaveBeenCalled();
  });
});
