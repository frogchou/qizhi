import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands } from "../../lib/tauri";
import { unavailableCommands } from "../../lib/tauri";
import { CodexDestinationDialog } from "./CodexDestinationDialog";

const projects = [
  {
    id: "project-recent",
    name: "最近项目",
    goal: "整理报告",
    rootPath: "managed",
    status: "active",
    createdAtUtcMs: 1,
    updatedAtUtcMs: 5,
    lastOpenedAtUtcMs: 8,
  },
  {
    id: "project-busy",
    name: "运行中的项目",
    goal: null,
    rootPath: "managed-busy",
    status: "running",
    createdAtUtcMs: 1,
    updatedAtUtcMs: 6,
    lastOpenedAtUtcMs: 7,
  },
];

const conversation = {
  id: "conversation-recent",
  projectId: "project-recent",
  title: "报告会话",
  codexThreadId: null,
  codexSessionId: null,
  status: "draft",
  createdAtUtcMs: 1,
  updatedAtUtcMs: 2,
  archivedAtUtcMs: null,
};

function commands(overrides: Partial<QizhiCommands> = {}): QizhiCommands {
  return {
    ...unavailableCommands,
    listCodexProjects: vi.fn().mockResolvedValue(projects),
    listCodexConversations: vi
      .fn()
      .mockImplementation(async (projectId) =>
        projectId === "project-recent" ? [conversation] : [],
      ),
    prepareCodexHandoff: vi.fn().mockResolvedValue({
      preparationId: "preparation-1",
      sourceKind: "today",
      fileCount: 2,
      totalSizeBytes: 120,
      previewItems: [
        { fileId: 1, displayName: "报告.docx", sizeBytes: 100 },
        { fileId: 2, displayName: "记录.md", sizeBytes: 20 },
      ],
      blockedItems: [],
      warningItems: [],
      requiresLargeFileConfirmation: false,
    }),
    commitCodexHandoff: vi.fn().mockResolvedValue({
      handoffId: "handoff-1",
      projectId: "project-recent",
      conversationId: "conversation-recent",
      itemCount: 2,
      status: "ready",
    }),
    ...overrides,
  };
}

const source = {
  kind: "today" as const,
  queryId: "query-1",
  fileIds: [1, 2],
  directoryIds: [],
};

describe("CodexDestinationDialog", () => {
  it("prepares the selection and defaults to the most recent usable destination", async () => {
    const client = commands();
    render(
      <CodexDestinationDialog
        commands={client}
        source={source}
        onClose={() => undefined}
        onCommitted={() => undefined}
      />,
    );

    expect(
      await screen.findByText("发送 2 项资料到 Codex"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Codex 项目")).toHaveValue("project-recent");
    await waitFor(() =>
      expect(screen.getByLabelText("项目会话")).toHaveValue(
        "conversation-recent",
      ),
    );
    expect(screen.getByRole("option", { name: /运行中的项目/ })).toBeDisabled();
  });

  it("uses the shared polished select control for projects and conversations", async () => {
    const client = commands();
    render(
      <CodexDestinationDialog
        commands={client}
        source={source}
        onClose={() => undefined}
        onCommitted={() => undefined}
      />,
    );

    await screen.findByText("发送 2 项资料到 Codex");
    const projectSelect = screen.getByLabelText("Codex 项目");
    const conversationSelect = screen.getByLabelText("项目会话");
    expect(projectSelect.closest(".codex-select-control")).not.toBeNull();
    expect(conversationSelect.closest(".codex-select-control")).not.toBeNull();
    expect(
      projectSelect.closest(".codex-select-control")?.querySelector("svg"),
    ).not.toBeNull();
    expect(
      conversationSelect.closest(".codex-select-control")?.querySelector("svg"),
    ).not.toBeNull();
  });

  it("creates a project and conversation in place, then keeps the new target selected", async () => {
    const newProject = { ...projects[0], id: "project-new", name: "新项目" };
    const newConversation = {
      ...conversation,
      id: "conversation-new",
      projectId: "project-new",
      title: "新会话",
    };
    const client = commands({
      createCodexProject: vi.fn().mockResolvedValue(newProject),
      createCodexConversation: vi.fn().mockResolvedValue(newConversation),
      listCodexProjects: vi
        .fn()
        .mockResolvedValueOnce(projects)
        .mockResolvedValueOnce([newProject, ...projects]),
      listCodexConversations: vi
        .fn()
        .mockImplementation(async (projectId) =>
          projectId === "project-new" ? [newConversation] : [conversation],
        ),
    });
    render(
      <CodexDestinationDialog
        commands={client}
        source={source}
        onClose={() => undefined}
        onCommitted={() => undefined}
      />,
    );
    await screen.findByText("发送 2 项资料到 Codex");
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "新项目" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并选择" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Codex 项目")).toHaveValue("project-new");
      expect(screen.getByLabelText("项目会话")).toHaveValue("conversation-new");
    });
  });

  it("requires warning confirmation, blocks invalid previews and navigates only once after ready", async () => {
    const onCommitted = vi.fn();
    const client = commands({
      prepareCodexHandoff: vi.fn().mockResolvedValue({
        preparationId: "preparation-warning",
        sourceKind: "today",
        fileCount: 1,
        totalSizeBytes: 60 * 1024 * 1024,
        previewItems: [
          { fileId: 1, displayName: "large.pdf", sizeBytes: 60 * 1024 * 1024 },
        ],
        blockedItems: [],
        warningItems: [
          { fileId: 1, displayName: "large.pdf", sizeBytes: 60 * 1024 * 1024 },
        ],
        requiresLargeFileConfirmation: true,
      }),
    });
    const firstRender = render(
      <CodexDestinationDialog
        commands={client}
        source={source}
        onClose={() => undefined}
        onCommitted={onCommitted}
      />,
    );
    await screen.findByText("large.pdf");
    expect(
      screen.getByRole("button", { name: "发送并打开 Codex" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByLabelText("确认复制大文件"));
    fireEvent.click(screen.getByRole("button", { name: "发送并打开 Codex" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    firstRender.unmount();

    const blockedClient = commands({
      prepareCodexHandoff: vi.fn().mockResolvedValue({
        preparationId: "preparation-blocked",
        sourceKind: "today",
        fileCount: 1,
        totalSizeBytes: 10,
        previewItems: [],
        blockedItems: [{ fileId: 3, displayName: "legacy.doc", sizeBytes: 10 }],
        warningItems: [],
        requiresLargeFileConfirmation: false,
      }),
    });
    render(
      <CodexDestinationDialog
        commands={blockedClient}
        source={source}
        onClose={() => undefined}
        onCommitted={() => undefined}
      />,
    );
    expect(await screen.findByText(/legacy\.doc/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发送并打开 Codex" }),
    ).toBeDisabled();
  });

  it("keeps the dialog open and does not navigate when commit fails", async () => {
    const onCommitted = vi.fn();
    const client = commands({
      commitCodexHandoff: vi.fn().mockRejectedValue(new Error("资料发生变化")),
    });
    render(
      <CodexDestinationDialog
        commands={client}
        source={source}
        onClose={() => undefined}
        onCommitted={onCommitted}
      />,
    );
    await screen.findByText("发送 2 项资料到 Codex");
    await waitFor(() =>
      expect(screen.getByLabelText("项目会话")).toHaveValue(
        "conversation-recent",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "发送并打开 Codex" }));
    expect(await screen.findByText("资料发生变化")).toBeInTheDocument();
    expect(onCommitted).not.toHaveBeenCalled();
  });
});
