import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    listScanRules: vi.fn().mockResolvedValue({
      allowedRoots: [],
      customExclusions: [],
      fileCategories: ["documents", "sourceCode"],
      lockedExclusions: [],
    }),
    saveScanRules: vi.fn(),
  };
}

describe("TodayPage", () => {
  it("renders file information, refreshes, and reveals only a selected file", async () => {
    const client = commands();
    render(<TodayPage commands={client} />);
    expect(await screen.findByText("周报.docx")).toBeInTheDocument();
    expect(screen.getByText("待分析")).toBeInTheDocument();
    expect(screen.getByText("本机文件")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "加入知识库（后续版本）" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByText("周报.docx"));
    expect(
      screen.getByRole("button", { name: "加入知识库（后续版本）" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "在资源管理器中定位" }));
    await waitFor(() =>
      expect(client.revealInExplorer).toHaveBeenCalledWith(7),
    );
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
      await screen.findByText("今天的扫描范围内还没有发现新文件。"),
    ).toBeInTheDocument();
  });

  it("keeps a long selected filename inside the detail panel", async () => {
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

    fireEvent.click(await screen.findByText(longName));
    const detailName = document.querySelector(".detail-panel h2");
    if (!detailName) throw new Error("未渲染文件详情标题");
    expect(detailName).toHaveAttribute("title", longName);
    expect(detailName.textContent).toBe(longName);
    expect(detailName.querySelectorAll("wbr")).toHaveLength(2);
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
      await screen.findByText("今天的扫描范围内还没有发现新文件。"),
    ).toBeInTheDocument();
    await waitFor(() => expect(client.refreshToday).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "刷新中…" })).toBeDisabled();
    completeRefresh?.({ state: "ready", files: [], clusters: [] });
  });

  it("follows an already-running scan instead of reporting a refresh failure", async () => {
    const client = commands({ state: "ready", files: [], clusters: [] });
    client.refreshToday = vi.fn().mockRejectedValue({
      remediation: "已有今日扫描正在进行，请等待它完成。",
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
    const names = screen.getAllByRole("button", { name: /\.docx|\.py|\.md/ });
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
});
