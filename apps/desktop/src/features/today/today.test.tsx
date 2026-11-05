import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands, TodaySnapshot } from "../../lib/tauri";
import { TodayPage } from "./TodayPage";

const readySnapshot: TodaySnapshot = {
  state: "ready" as const,
  files: [
    {
      id: 7,
      canonicalPath: "D:\\工作\\周报.docx",
      modifiedAtUtcMs: 1_793_189_400_000,
      sizeBytes: 1024,
      source: "本机文件",
      status: "待分析",
    },
  ],
  clusters: [{ label: "本机文件", fileIds: [7] }],
};

function commands(snapshot: TodaySnapshot = readySnapshot): QizhiCommands {
  return {
    getSettings: vi.fn().mockResolvedValue([]),
    saveSettings: vi.fn(),
    testServiceConnection: vi.fn(),
    pickFolder: vi.fn(),
    getTodaySnapshot: vi.fn().mockResolvedValue(snapshot),
    refreshToday: vi.fn().mockResolvedValue(snapshot),
    revealInExplorer: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
    openFileInTextEditor: vi.fn().mockResolvedValue(undefined),
    copyFileToClipboard: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    excludeFileDirectory: vi.fn().mockResolvedValue(snapshot),
    uploadTodayFile: vi.fn(),
    listScanRules: vi.fn().mockResolvedValue({
      allowedRoots: [],
      customExclusions: [],
      fileCategories: ["documents", "sourceCode"],
      directoryGroupThreshold: 5,
      lockedExclusions: [],
    }),
    saveScanRules: vi.fn(),
  };
}

describe("TodayPage", () => {
  it("sends multiple selected files from the page header and clears them only after a ready handoff", async () => {
    const client = commands();
    client.queryTodayWorkspace = vi.fn().mockResolvedValue({
      queryId: "query-today",
      totalFileCount: 2,
      nextCursor: null,
      entries: [
        {
          id: "file-7",
          kind: "file",
          name: "周报.docx",
          canonicalPath: "D:\\工作\\周报.docx",
          fileId: 7,
          modifiedAtUtcMs: 1_793_189_400_000,
          sizeBytes: 1024,
          source: "本机 NTFS 索引",
          fileCount: 1,
          childDirectoryCount: 0,
          hasChildren: false,
          valueSummary: {
            valuable: 0,
            notValuable: 0,
            pending: 1,
            failed: 0,
            unsupported: 0,
          },
        },
        {
          id: "file-8",
          kind: "file",
          name: "预算.xlsx",
          canonicalPath: "D:\\工作\\预算.xlsx",
          fileId: 8,
          modifiedAtUtcMs: 1_793_189_300_000,
          sizeBytes: 2048,
          source: "本机 NTFS 索引",
          fileCount: 1,
          childDirectoryCount: 0,
          hasChildren: false,
          valueSummary: {
            valuable: 1,
            notValuable: 0,
            pending: 0,
            failed: 0,
            unsupported: 0,
          },
        },
      ],
    });
    client.prepareCodexHandoff = vi.fn().mockResolvedValue({
      preparationId: "preparation-today",
      sourceKind: "today",
      fileCount: 2,
      totalSizeBytes: 3072,
      previewItems: [
        { fileId: 7, displayName: "周报.docx", sizeBytes: 1024 },
        { fileId: 8, displayName: "预算.xlsx", sizeBytes: 2048 },
      ],
      blockedItems: [],
      warningItems: [],
      requiresLargeFileConfirmation: false,
    });
    client.listCodexProjects = vi.fn().mockResolvedValue([
      {
        id: "project-1",
        name: "报告项目",
        goal: null,
        rootPath: "managed",
        status: "active",
        createdAtUtcMs: 1,
        updatedAtUtcMs: 1,
        lastOpenedAtUtcMs: 1,
      },
    ]);
    client.listCodexConversations = vi.fn().mockResolvedValue([
      {
        id: "conversation-1",
        projectId: "project-1",
        title: "整理周报",
        codexThreadId: null,
        codexSessionId: null,
        status: "draft",
        createdAtUtcMs: 1,
        updatedAtUtcMs: 1,
        archivedAtUtcMs: null,
      },
    ]);
    client.commitCodexHandoff = vi.fn().mockResolvedValue({
      handoffId: "handoff-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      itemCount: 1,
      status: "ready",
    });
    const onOpenCodex = vi.fn();
    render(<TodayPage commands={client} onOpenCodex={onOpenCodex} />);

    const firstCheckbox = await screen.findByLabelText("选择 周报.docx");
    const secondCheckbox = await screen.findByLabelText("选择 预算.xlsx");
    fireEvent.click(firstCheckbox);
    fireEvent.click(secondCheckbox);
    const pageHeader = document.querySelector(".today-page > .page-header");
    expect(pageHeader).not.toBeNull();
    fireEvent.click(
      within(pageHeader as HTMLElement).getByRole("button", {
        name: "发送到 Codex",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "发送资料到 Codex" }),
    ).toBeInTheDocument();
    expect(client.prepareCodexHandoff).toHaveBeenCalledWith({
      source: {
        kind: "today",
        queryId: "query-today",
        fileIds: [7, 8],
        directoryIds: [],
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("项目会话")).toHaveValue("conversation-1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "发送并打开 Codex" }));
    await waitFor(() => expect(onOpenCodex).toHaveBeenCalledTimes(1));
    expect(firstCheckbox).not.toBeChecked();
    expect(secondCheckbox).not.toBeChecked();
  });

  it("uses the recent source for the past tab and the exact file for the context-menu action", async () => {
    const client = commands();
    client.getRecentSnapshot = vi.fn().mockResolvedValue(readySnapshot);
    client.queryTodayWorkspace = vi.fn().mockImplementation(async (input) => ({
      queryId: input.scope === "recent" ? "query-recent" : "query-today",
      totalFileCount: 1,
      nextCursor: null,
      entries: [
        {
          id: "file-7",
          kind: "file",
          name: "周报.docx",
          canonicalPath: "D:\\工作\\周报.docx",
          fileId: 7,
          modifiedAtUtcMs: 1_793_189_400_000,
          sizeBytes: 1024,
          source: "本机 NTFS 索引",
          fileCount: 1,
          childDirectoryCount: 0,
          hasChildren: false,
          valueSummary: {
            valuable: 0,
            notValuable: 0,
            pending: 1,
            failed: 0,
            unsupported: 0,
          },
        },
      ],
    }));
    client.prepareCodexHandoff = vi
      .fn()
      .mockRejectedValue(new Error("当前目录查询已过期，请刷新列表"));
    client.listCodexProjects = vi.fn().mockResolvedValue([]);
    render(<TodayPage commands={client} />);

    fireEvent.click(await screen.findByRole("tab", { name: "过去" }));
    await screen.findByText("过去 5 天");
    fireEvent.contextMenu(await screen.findByText("周报.docx"));
    fireEvent.click(screen.getByRole("menuitem", { name: "发送到 Codex" }));
    expect(
      await screen.findByText("当前目录查询已过期，请刷新列表"),
    ).toBeInTheDocument();
    expect(client.prepareCodexHandoff).toHaveBeenCalledWith({
      source: {
        kind: "recent",
        queryId: "query-recent",
        fileIds: [7],
        directoryIds: [],
      },
    });
  });

  it("groups busy directories and expands their changed files on demand", async () => {
    const client = commands();
    const summary = {
      valuable: 2,
      notValuable: 1,
      pending: 5,
      failed: 0,
      unsupported: 0,
    };
    client.queryTodayWorkspace = vi.fn().mockResolvedValue({
      queryId: "query-1",
      totalFileCount: 8,
      nextCursor: null,
      entries: [
        {
          id: "project-a",
          kind: "directory",
          name: "项目A",
          canonicalPath: "D:\\工作\\项目A",
          fileId: null,
          modifiedAtUtcMs: 1_793_189_400_000,
          sizeBytes: 1024,
          source: "本机 NTFS 索引",
          fileCount: 8,
          childDirectoryCount: 1,
          hasChildren: true,
          valueSummary: summary,
        },
      ],
    });
    client.expandTodayWorkspace = vi.fn().mockResolvedValue({
      queryId: "query-1",
      totalFileCount: 8,
      nextCursor: null,
      entries: [
        {
          id: "src",
          kind: "directory",
          name: "src",
          canonicalPath: "D:\\工作\\项目A\\src",
          fileId: null,
          modifiedAtUtcMs: 1_793_189_400_000,
          sizeBytes: 1024,
          source: "本机 NTFS 索引",
          fileCount: 8,
          childDirectoryCount: 0,
          hasChildren: true,
          valueSummary: summary,
        },
      ],
    });
    client.openTodayWorkspaceDirectory = vi.fn().mockResolvedValue(undefined);

    render(<TodayPage commands={client} />);

    expect(await screen.findByText("项目A")).toBeInTheDocument();
    expect(screen.getByText("8 个文件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开 项目A" }));
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(client.expandTodayWorkspace).toHaveBeenCalledWith(
      "query-1",
      "project-a",
      0,
    );

    fireEvent.click(screen.getByLabelText("选择 src"));
    expect(
      (screen.getByLabelText("选择 项目A") as HTMLInputElement).indeterminate,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText("选择 项目A"));
    expect(screen.getByLabelText("选择 src")).toBeChecked();
    expect(screen.getByLabelText("选择 src")).toBeDisabled();

    expect(screen.getByText(/已选 1 项/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("按文件名搜索"), {
      target: { value: "*.md" },
    });
    await waitFor(() =>
      expect(screen.getByText(/已选 0 项/)).toBeInTheDocument(),
    );
  });

  it("requires confirmation before a directory summary spans multiple batches", async () => {
    const client = commands();
    client.getSummarySettings = vi.fn().mockResolvedValue({
      model: "gpt-5.6",
      templates: [
        {
          id: 3,
          title: "今日工作总结",
          prompt: "总结成果。",
          sortOrder: 0,
          isDefault: true,
        },
      ],
    });
    client.queryTodayWorkspace = vi.fn().mockResolvedValue({
      queryId: "query-large",
      totalFileCount: 21,
      nextCursor: null,
      entries: [
        {
          id: "large-directory",
          kind: "directory",
          name: "资料整理",
          canonicalPath: "D:\\工作\\资料整理",
          fileId: null,
          modifiedAtUtcMs: 1_793_189_400_000,
          sizeBytes: 1024,
          source: "本机 NTFS 索引",
          fileCount: 21,
          childDirectoryCount: 0,
          hasChildren: true,
          valueSummary: {
            valuable: 0,
            notValuable: 0,
            pending: 21,
            failed: 0,
            unsupported: 0,
          },
        },
      ],
    });
    client.prepareWorkSummary = vi.fn().mockResolvedValue({
      fileCount: 21,
      batchCount: 2,
      requiresConfirmation: true,
    });
    client.generateWorkSummary = vi.fn().mockResolvedValue({
      markdown: "# 总结",
      truncated: false,
      fileCount: 21,
      templateTitle: "今日工作总结",
    });

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByLabelText("选择 资料整理"));
    fireEvent.click(screen.getByRole("button", { name: "生成今日总结" }));

    expect(
      await screen.findByRole("dialog", { name: "确认分批总结" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/21 个文件，将分为 2 批/)).toBeInTheDocument();
    expect(client.generateWorkSummary).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("按文件名搜索"), {
      target: { value: "*.md" },
    });

    fireEvent.click(screen.getByRole("button", { name: "继续分批总结" }));
    await waitFor(() =>
      expect(client.generateWorkSummary).toHaveBeenCalledWith(
        {
          queryId: "query-large",
          fileIds: [],
          directoryIds: ["large-directory"],
          templateId: 3,
          confirmedMultiBatch: true,
        },
        expect.any(Function),
      ),
    );
  });

  it("renders the summary action as one compact split button", async () => {
    render(<TodayPage commands={commands()} />);

    await screen.findByText("周报.docx");
    const group = screen.getByRole("group", { name: "今日总结操作" });
    expect(group).toHaveClass("summary-split-button");
    expect(
      screen.getByRole("button", { name: "选择总结方式" }).querySelector("svg"),
    ).not.toBeNull();
  });

  it("locks the file selection and workspace tabs while a summary is running", async () => {
    let finishSummary!: (value: {
      markdown: string;
      truncated: boolean;
      fileCount: number;
      templateTitle: string;
    }) => void;
    const client = commands();
    client.getSummarySettings = vi.fn().mockResolvedValue({
      model: "gpt-5.6",
      templates: [
        {
          id: 3,
          title: "今日工作总结",
          prompt: "总结成果。",
          sortOrder: 0,
          isDefault: true,
        },
      ],
    });
    client.generateWorkSummary = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSummary = resolve;
        }),
    );

    render(<TodayPage commands={client} />);
    const fileCheckbox = await screen.findByLabelText("选择 周报.docx");
    fireEvent.click(fileCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "生成今日总结" }));

    expect(
      screen.getByRole("dialog", { name: "工作总结" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("正在生成总结…")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "复制" })).toBeDisabled();
    await waitFor(() => expect(fileCheckbox).toBeDisabled());
    expect(screen.getByRole("tab", { name: "过去" })).toBeDisabled();
    expect(screen.getByLabelText("选择全部文件")).toBeDisabled();

    finishSummary({
      markdown: "# 总结",
      truncated: false,
      fileCount: 1,
      templateTitle: "今日工作总结",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "复制" })).toBeEnabled(),
    );
  });

  it("renders streamed Markdown as formatted content before generation completes", async () => {
    let finishSummary!: (value: {
      markdown: string;
      truncated: boolean;
      fileCount: number;
      templateTitle: string;
    }) => void;
    const client = commands();
    client.getSummarySettings = vi.fn().mockResolvedValue({
      model: "gpt-5.6",
      templates: [
        {
          id: 3,
          title: "今日工作总结",
          prompt: "总结成果。",
          sortOrder: 0,
          isDefault: true,
        },
      ],
    });
    client.generateWorkSummary = vi
      .fn()
      .mockImplementation((_input, onEvent) => {
        onEvent?.({
          kind: "started",
          templateTitle: "今日工作总结",
          fileCount: 1,
        });
        onEvent?.({
          kind: "delta",
          delta: "# 关键成果\n\n- **完成索引**\n\n**事实: **我已完成目录聚合。",
        });
        return new Promise((resolve) => {
          finishSummary = resolve;
        });
      });

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByLabelText("选择 周报.docx"));
    fireEvent.click(screen.getByRole("button", { name: "生成今日总结" }));

    expect(
      await screen.findByRole("heading", { name: "关键成果", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("完成索引").tagName).toBe("STRONG");
    expect(screen.getByText("事实:").tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*事实:/)).toBeNull();
    expect(screen.queryByText("# 关键成果", { exact: true })).toBeNull();

    finishSummary({
      markdown: "# 关键成果\n\n- **完成索引**",
      truncated: false,
      fileCount: 1,
      templateTitle: "今日工作总结",
    });
  });

  it("keeps streamed content visible when generation fails", async () => {
    const client = commands();
    client.getSummarySettings = vi.fn().mockResolvedValue({
      model: "gpt-5.6",
      templates: [
        {
          id: 3,
          title: "今日工作总结",
          prompt: "总结成果。",
          sortOrder: 0,
          isDefault: true,
        },
      ],
    });
    client.generateWorkSummary = vi
      .fn()
      .mockImplementation((_input, onEvent) => {
        onEvent?.({ kind: "delta", delta: "## 已生成内容" });
        return Promise.reject(new Error("上游连接中断"));
      });

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByLabelText("选择 周报.docx"));
    fireEvent.click(screen.getByRole("button", { name: "生成今日总结" }));

    expect(
      await screen.findByRole("heading", { name: "已生成内容", level: 2 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("上游连接中断")).toBeInTheDocument();
    expect(screen.getByText("生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制" })).toBeDisabled();
  });

  it("does not reopen a closed dialog when late stream events arrive", async () => {
    let emit!: (event: { kind: "delta"; delta: string }) => void;
    let finishSummary!: (value: {
      markdown: string;
      truncated: boolean;
      fileCount: number;
      templateTitle: string;
    }) => void;
    const client = commands();
    client.getSummarySettings = vi.fn().mockResolvedValue({
      model: "gpt-5.6",
      templates: [
        {
          id: 3,
          title: "今日工作总结",
          prompt: "总结成果。",
          sortOrder: 0,
          isDefault: true,
        },
      ],
    });
    client.generateWorkSummary = vi
      .fn()
      .mockImplementation((_input, onEvent) => {
        emit = onEvent;
        return new Promise((resolve) => {
          finishSummary = resolve;
        });
      });

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByLabelText("选择 周报.docx"));
    fireEvent.click(screen.getByRole("button", { name: "生成今日总结" }));
    fireEvent.click(await screen.findByRole("button", { name: "关闭总结" }));

    emit({ kind: "delta", delta: "# 晚到内容" });
    finishSummary({
      markdown: "# 晚到内容",
      truncated: false,
      fileCount: 1,
      templateTitle: "今日工作总结",
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "工作总结" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("summarizes checked files with the default template and saves the Markdown result", async () => {
    const client = commands();
    client.getSummarySettings = vi.fn().mockResolvedValue({
      model: "gpt-5.6",
      templates: [
        {
          id: 3,
          title: "今日工作总结",
          prompt: "总结成果。",
          sortOrder: 0,
          isDefault: true,
        },
      ],
    });
    client.generateWorkSummary = vi.fn().mockResolvedValue({
      markdown: "# 今日总结\n\n完成了本地索引。",
      truncated: false,
      fileCount: 1,
      templateTitle: "今日工作总结",
    });
    client.pickSummarySavePath = vi.fn().mockResolvedValue("D:\\今日总结.md");
    client.saveSummaryMarkdown = vi.fn().mockResolvedValue({
      savedPath: "D:\\今日总结.md",
    });

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByLabelText("选择 周报.docx"));
    fireEvent.click(screen.getByRole("button", { name: "生成今日总结" }));

    expect(
      await screen.findByRole("dialog", { name: "工作总结" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/完成了本地索引。/)).toBeInTheDocument();
    expect(client.generateWorkSummary).toHaveBeenCalledWith(
      {
        fileIds: [7],
        templateId: 3,
      },
      expect.any(Function),
    );

    fireEvent.click(screen.getByRole("button", { name: "另存为 Markdown" }));
    await waitFor(() =>
      expect(client.saveSummaryMarkdown).toHaveBeenCalledWith({
        content: "# 今日总结\n\n完成了本地索引。",
        path: "D:\\今日总结.md",
      }),
    );
  });
  it("switches to the recent five-day workspace when the past tab is selected", async () => {
    const pastSnapshot: TodaySnapshot = {
      state: "ready",
      files: [
        {
          ...readySnapshot.files[0],
          id: 8,
          canonicalPath: "D:\\工作\\昨天的方案.md",
        },
      ],
      clusters: [{ label: "本机 NTFS 索引", fileIds: [8] }],
    };
    const client = commands();
    client.getRecentSnapshot = vi.fn().mockResolvedValue(pastSnapshot);

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByRole("tab", { name: "过去" }));

    expect(await screen.findByText("昨天的方案.md")).toBeInTheDocument();
    expect(client.getRecentSnapshot).toHaveBeenCalledWith(5);
  });

  it("does not automatically assess past files and only assesses checked files on request", async () => {
    const pastSnapshot: TodaySnapshot = {
      state: "ready",
      files: [
        {
          ...readySnapshot.files[0],
          id: 8,
          canonicalPath: "D:\\工作\\昨天的方案.md",
        },
      ],
      clusters: [{ label: "本机 NTFS 索引", fileIds: [8] }],
    };
    const client = commands();
    client.getRecentSnapshot = vi.fn().mockResolvedValue(pastSnapshot);

    render(<TodayPage commands={client} />);
    await screen.findByText("周报.docx");
    fireEvent.click(await screen.findByRole("tab", { name: "过去" }));

    expect(await screen.findByText("昨天的方案.md")).toBeInTheDocument();
    expect(screen.getByText("待手动评估")).toBeInTheDocument();

    client.evaluateTodayFiles = vi
      .fn()
      .mockResolvedValue([{ fileId: 8, status: "有价值", score: 3.6 }]);

    fireEvent.click(screen.getByLabelText("选择 昨天的方案.md"));
    fireEvent.click(screen.getByRole("button", { name: "手动评估所选" }));
    await waitFor(() =>
      expect(client.evaluateTodayFiles).toHaveBeenCalledWith([8]),
    );
  });

  it("refreshes the recent workspace without replacing it with today's files", async () => {
    const pastSnapshot: TodaySnapshot = {
      state: "ready",
      files: [
        {
          ...readySnapshot.files[0],
          id: 8,
          canonicalPath: "D:\\工作\\昨天的方案.md",
        },
      ],
      clusters: [{ label: "本机 NTFS 索引", fileIds: [8] }],
    };
    const client = commands();
    client.getRecentSnapshot = vi.fn().mockResolvedValue(pastSnapshot);

    render(<TodayPage commands={client} />);
    fireEvent.click(await screen.findByRole("tab", { name: "过去" }));
    fireEvent.click(await screen.findByRole("button", { name: "刷新列表" }));

    await waitFor(() =>
      expect(client.getRecentSnapshot).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("昨天的方案.md")).toBeInTheDocument();
  });

  it("automatically replaces the pending value state with the JEV result", async () => {
    const client = commands() as QizhiCommands & {
      evaluateTodayFiles: (
        fileIds: number[],
      ) => Promise<{ fileId: number; status: string; score: number | null }[]>;
    };
    client.evaluateTodayFiles = vi
      .fn()
      .mockResolvedValue([{ fileId: 7, status: "有价值", score: 3.6 }]);

    render(<TodayPage commands={client} />);

    expect(
      await screen.findByRole("button", { name: "有价值" }),
    ).toBeInTheDocument();
  });

  it("defaults to documents and sends only visible document files to JEV", async () => {
    const snapshot: TodaySnapshot = {
      state: "ready",
      files: [
        {
          ...readySnapshot.files[0],
          id: 1,
          canonicalPath: "D:\\工作\\年度方案.docx",
        },
        {
          ...readySnapshot.files[0],
          id: 2,
          canonicalPath: "D:\\工作\\会议纪要.txt",
        },
        {
          ...readySnapshot.files[0],
          id: 3,
          canonicalPath: "D:\\工作\\项目说明.md",
        },
        {
          ...readySnapshot.files[0],
          id: 4,
          canonicalPath: "D:\\工作\\package.json",
        },
        {
          ...readySnapshot.files[0],
          id: 5,
          canonicalPath: "D:\\工作\\main.rs",
        },
        {
          ...readySnapshot.files[0],
          id: 6,
          canonicalPath: "D:\\工作\\report.py",
        },
      ],
      clusters: [{ label: "本机文件", fileIds: [1, 2, 3, 4, 5, 6] }],
    };
    const client = commands(snapshot) as QizhiCommands & {
      evaluateTodayFiles: ReturnType<typeof vi.fn>;
    };
    client.evaluateTodayFiles = vi.fn().mockResolvedValue([
      { fileId: 1, status: "有价值", score: 3.7 },
      { fileId: 2, status: "低价值", score: 1.2 },
      { fileId: 3, status: "有价值", score: 3.2 },
    ]);

    render(<TodayPage commands={client} />);

    expect(await screen.findByLabelText("文件类型筛选")).toHaveValue(
      "documents",
    );
    expect(screen.getByText("年度方案.docx")).toBeInTheDocument();
    expect(screen.getByText("会议纪要.txt")).toBeInTheDocument();
    expect(screen.getByText("项目说明.md")).toBeInTheDocument();
    expect(screen.queryByText("package.json")).not.toBeInTheDocument();
    expect(screen.queryByText("main.rs")).not.toBeInTheDocument();
    expect(screen.queryByText("report.py")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(client.evaluateTodayFiles).toHaveBeenCalledWith([1, 2, 3]),
    );

    fireEvent.change(screen.getByLabelText("文件类型筛选"), {
      target: { value: "sourceCode" },
    });
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("main.rs")).toBeInTheDocument();
    expect(screen.getByText("report.py")).toBeInTheDocument();
    expect(screen.getAllByText("不评估")).toHaveLength(3);
  });

  it("maps every value assessment state to a stable visual class", async () => {
    const states: TodaySnapshot extends { files: infer T } ? T : never = [
      { ...readySnapshot.files[0], id: 1, status: "待分析" },
      { ...readySnapshot.files[0], id: 2, status: "有价值" },
      { ...readySnapshot.files[0], id: 3, status: "低价值" },
      { ...readySnapshot.files[0], id: 4, status: "无法解析" },
      { ...readySnapshot.files[0], id: 5, status: "评估失败" },
    ];
    render(
      <TodayPage
        commands={commands({
          state: "ready",
          files: states,
          clusters: [{ label: "本机文件", fileIds: [1, 2, 3, 4, 5] }],
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: "评估中" })).toHaveClass(
      "status-pending",
    );
    expect(screen.getByRole("button", { name: "有价值" })).toHaveClass(
      "status-valuable",
    );
    expect(screen.getByRole("button", { name: "低价值" })).toHaveClass(
      "status-low",
    );
    expect(screen.getByRole("button", { name: "无法解析" })).toHaveClass(
      "status-unsupported",
    );
    expect(screen.getByRole("button", { name: "评估失败" })).toHaveClass(
      "status-error",
    );
    expect(screen.getAllByRole("button", { name: "打开" })).toHaveLength(5);
  });

  it("renders file information, refreshes, and reveals only a selected file", async () => {
    const client = commands();
    render(<TodayPage commands={client} />);
    expect(await screen.findByText("周报.docx")).toBeInTheDocument();
    expect(screen.getByText("评估中")).toBeInTheDocument();
    expect(screen.getByText("本机文件")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "文件名" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(client.refreshToday).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(client.refreshToday).toHaveBeenCalledTimes(2));
  });

  it("shows remediation rather than an empty table when discovery is unavailable", async () => {
    render(
      <TodayPage
        commands={commands({
          state: "unavailable",
          remediation: "本地 NTFS 索引服务暂不可用。",
          files: [],
          clusters: [],
        })}
      />,
    );
    expect(
      await screen.findByText("本地 NTFS 索引服务暂不可用。"),
    ).toBeInTheDocument();
  });

  it("explains that an empty ready snapshot found no files in the approved scope", async () => {
    render(
      <TodayPage
        commands={commands({ state: "ready", files: [], clusters: [] })}
      />,
    );

    expect(
      await screen.findByText("今天的扫描范围内还没有发现新建或修改的文件。"),
    ).toBeInTheDocument();
  });

  it("keeps a long filename constrained to its table cell", async () => {
    const longName = `${"x".repeat(120)}.txt`;
    render(
      <TodayPage
        commands={commands({
          ...readySnapshot,
          files: [
            {
              ...readySnapshot.files[0],
              canonicalPath: `D:\\工作\\${longName}`,
            },
          ],
        })}
      />,
    );

    const title = await screen.findByTitle(longName);
    expect(title).toHaveClass("file-title");
    expect(title.textContent).toContain(longName);
  });

  it("renders each file as one compact table row without a second size line", async () => {
    render(<TodayPage commands={commands()} />);

    const title = await screen.findByTitle("周报.docx");
    expect(title.querySelector("small")).toBeNull();
    expect(document.querySelector(".file-table-wrap")).toBeInTheDocument();
  });

  it("keeps the cached today view usable while a background refresh is running", async () => {
    let completeRefresh: ((value: TodaySnapshot) => void) | undefined;
    const client = commands({ state: "ready", files: [], clusters: [] });
    client.refreshToday = vi.fn(
      () =>
        new Promise<TodaySnapshot>((resolve) => {
          completeRefresh = resolve;
        }),
    );

    render(<TodayPage commands={client} />);

    expect(
      await screen.findByText("今天的扫描范围内还没有发现新建或修改的文件。"),
    ).toBeInTheDocument();
    await waitFor(() => expect(client.refreshToday).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "刷新中…" })).toBeDisabled();
    completeRefresh?.({ state: "ready", files: [], clusters: [] });
  });

  it("follows an already-running scan instead of reporting a refresh failure", async () => {
    const client = commands({ state: "ready", files: [], clusters: [] });
    client.refreshToday = vi.fn().mockRejectedValue({
      remediation: "本地索引服务正在处理另一项索引任务",
    });
    client.getTodayScanStatus = vi.fn().mockResolvedValue({
      state: "scanning",
      directoriesScanned: 12,
      candidatesFound: 2,
      startedAtUtcMs: 1,
      completedAtUtcMs: null,
      message: null,
    });

    render(<TodayPage commands={client} />);

    expect(
      await screen.findByText("另一轮扫描正在进行，完成后将自动更新。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("刷新未完成，请检查扫描范围和文件访问权限。"),
    ).not.toBeInTheDocument();
  });

  it("explains that a running refresh is synchronizing the NTFS index", async () => {
    let completeRefresh: ((value: TodaySnapshot) => void) | undefined;
    const client = commands({ state: "ready", files: [], clusters: [] });
    client.getTodayScanStatus = vi.fn().mockResolvedValue({
      state: "scanning",
      directoriesScanned: 42,
      candidatesFound: 3,
      startedAtUtcMs: 1,
      completedAtUtcMs: null,
      message: null,
    });
    client.refreshToday = vi.fn(
      () =>
        new Promise<TodaySnapshot>((resolve) => {
          completeRefresh = resolve;
        }),
    );

    render(<TodayPage commands={client} />);

    expect(
      await screen.findByText(
        "正在建立或同步本地 NTFS 索引；不会递归遍历文件夹。",
      ),
    ).toBeInTheDocument();
    completeRefresh?.({ state: "ready", files: [], clusters: [] });
  });

  it("filters by supported file type, matches wildcard file names, and sorts the visible list", async () => {
    const snapshot: TodaySnapshot = {
      state: "ready",
      files: [
        {
          ...readySnapshot.files[0],
          id: 1,
          canonicalPath: "D:\\工作\\周报.docx",
          modifiedAtUtcMs: 100,
        },
        {
          ...readySnapshot.files[0],
          id: 2,
          canonicalPath: "D:\\工作\\analysis.py",
          modifiedAtUtcMs: 300,
        },
        {
          ...readySnapshot.files[0],
          id: 3,
          canonicalPath: "D:\\工作\\会议纪要.md",
          modifiedAtUtcMs: 200,
        },
      ],
      clusters: [{ label: "本机文件", fileIds: [1, 2, 3] }],
    };
    render(<TodayPage commands={commands(snapshot)} />);
    await screen.findByText("周报.docx");

    fireEvent.change(screen.getByLabelText("文件类型筛选"), {
      target: { value: "sourceCode" },
    });
    expect(screen.getByText("analysis.py")).toBeInTheDocument();
    expect(screen.queryByText("周报.docx")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("文件类型筛选"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("按文件名搜索"), {
      target: { value: "周*.docx" },
    });
    expect(screen.getByText("周报.docx")).toBeInTheDocument();
    expect(screen.queryByText("analysis.py")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("按文件名搜索"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("排序方式"), {
      target: { value: "name-asc" },
    });
    const names = Array.from(document.querySelectorAll(".file-title strong"));
    expect(names.map((item) => item.textContent)).toEqual([
      expect.stringContaining("会议纪要.md"),
      expect.stringContaining("周报.docx"),
      expect.stringContaining("analysis.py"),
    ]);
  });

  it("shows only recognized documents when the document filter is selected", async () => {
    const snapshot: TodaySnapshot = {
      state: "ready",
      files: [
        {
          ...readySnapshot.files[0],
          id: 11,
          canonicalPath: "D:\\工作\\出差申请.docx",
        },
        {
          ...readySnapshot.files[0],
          id: 12,
          canonicalPath: "D:\\工作\\report.py",
        },
        {
          ...readySnapshot.files[0],
          id: 13,
          canonicalPath: "D:\\工作\\build-output.o",
        },
      ],
      clusters: [{ label: "本机文件", fileIds: [11, 12, 13] }],
    };
    render(<TodayPage commands={commands(snapshot)} />);
    await screen.findByText("出差申请.docx");

    fireEvent.change(screen.getByLabelText("文件类型筛选"), {
      target: { value: "documents" },
    });

    expect(screen.getByText("出差申请.docx")).toBeInTheDocument();
    expect(screen.queryByText("report.py")).not.toBeInTheDocument();
    expect(screen.queryByText("build-output.o")).not.toBeInTheDocument();
  });

  it("offers native file actions from a file row context menu", async () => {
    const client = commands();
    render(<TodayPage commands={client} />);
    const file = await screen.findByText("周报.docx");

    fireEvent.contextMenu(file);

    expect(
      screen.getByRole("menuitem", { name: "打开文件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "使用文本编辑器打开" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "打开文件所在位置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "复制文件" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "删除文件" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "复制文件" }));
    await waitFor(() =>
      expect(client.copyFileToClipboard).toHaveBeenCalledWith(7),
    );
  });

  it("keeps a context menu opened on a bottom row inside the viewport", async () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const originalHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 600,
    });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("file-context-menu")) {
          return {
            x: 0,
            y: 0,
            width: 180,
            height: 280,
            top: 0,
            right: 180,
            bottom: 280,
            left: 0,
            toJSON: () => ({}),
          };
        }
        return originalBounds.call(this);
      });

    try {
      render(<TodayPage commands={commands()} />);
      fireEvent.contextMenu(await screen.findByText("周报.docx"), {
        clientX: 1000,
        clientY: 580,
      });

      const menu = await screen.findByRole("menu");
      await waitFor(() => {
        expect(menu).toHaveStyle({ left: "836px", top: "312px" });
      });
    } finally {
      bounds.mockRestore();
      if (originalWidth) {
        Object.defineProperty(window, "innerWidth", originalWidth);
      }
      if (originalHeight) {
        Object.defineProperty(window, "innerHeight", originalHeight);
      }
    }
  });

  it("blocks the selected file parent and immediately replaces the visible snapshot", async () => {
    const client = commands() as QizhiCommands & {
      excludeFileDirectory: ReturnType<typeof vi.fn>;
    };
    client.excludeFileDirectory = vi.fn().mockResolvedValue({
      state: "ready",
      files: [],
      clusters: [],
    });
    render(<TodayPage commands={client} />);
    const file = await screen.findByText("周报.docx");

    fireEvent.contextMenu(file);
    fireEvent.click(screen.getByRole("menuitem", { name: "屏蔽该目录文件" }));

    await waitFor(() =>
      expect(client.excludeFileDirectory).toHaveBeenCalledWith(7),
    );
    expect(
      await screen.findByText("今天的扫描范围内还没有发现新建或修改的文件。"),
    ).toBeInTheDocument();
  });

  it("requires a knowledge base choice before uploading the selected file", async () => {
    const client = commands() as QizhiCommands & {
      listRagflowDatasets: ReturnType<typeof vi.fn>;
      uploadTodayFile: ReturnType<typeof vi.fn>;
    };
    client.listRagflowDatasets = vi
      .fn()
      .mockResolvedValue([
        { id: "kb-work", name: "工作资料", description: "项目文档" },
      ]);
    client.uploadTodayFile = vi.fn().mockResolvedValue({
      documentCount: 1,
      parsingStarted: true,
    });
    render(<TodayPage commands={client} />);
    const file = await screen.findByText("周报.docx");

    fireEvent.contextMenu(file);
    fireEvent.click(screen.getByRole("menuitem", { name: "上传到知识库" }));

    expect(
      await screen.findByRole("dialog", { name: "上传到知识库" }),
    ).toBeInTheDocument();
    const upload = screen.getByRole("button", { name: "上传" });
    expect(upload).toBeDisabled();
    fireEvent.change(screen.getByLabelText("目标知识库"), {
      target: { value: "kb-work" },
    });
    fireEvent.click(upload);

    await waitFor(() =>
      expect(client.uploadTodayFile).toHaveBeenCalledWith({
        fileId: 7,
        datasetId: "kb-work",
        parentPath: null,
        startParsing: true,
      }),
    );
    expect(
      await screen.findByText("文件已上传并开始解析。"),
    ).toBeInTheDocument();
  });

  it("keeps the upload result when RAGFlow accepted the file but parsing did not start", async () => {
    const client = commands() as QizhiCommands & {
      listRagflowDatasets: ReturnType<typeof vi.fn>;
      uploadTodayFile: ReturnType<typeof vi.fn>;
    };
    client.listRagflowDatasets = vi
      .fn()
      .mockResolvedValue([
        { id: "kb-work", name: "工作资料", description: "" },
      ]);
    client.uploadTodayFile = vi.fn().mockResolvedValue({
      documentCount: 1,
      documentIds: ["document-1"],
      parsingStarted: false,
      parsingError: "RAGFlow 解析服务暂不可用。",
    });
    render(<TodayPage commands={client} />);

    fireEvent.contextMenu(await screen.findByText("周报.docx"));
    fireEvent.click(screen.getByRole("menuitem", { name: "上传到知识库" }));
    fireEvent.change(await screen.findByLabelText("目标知识库"), {
      target: { value: "kb-work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上传" }));

    expect(
      await screen.findByText(
        "文件已上传，但未能启动解析：RAGFlow 解析服务暂不可用。",
      ),
    ).toBeInTheDocument();
  });
});
