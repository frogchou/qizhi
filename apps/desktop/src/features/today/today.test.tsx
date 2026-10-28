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
    listScanRules: vi.fn().mockResolvedValue({
      allowedRoots: [],
      customExclusions: [],
      fileCategories: ["documents", "sourceCode"],
      everythingSdkPath: null,
      esCliPath: null,
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
          remediation: "请安装并启动 Everything。",
          files: [],
          clusters: [],
        })}
      />,
    );
    expect(
      await screen.findByText("请安装并启动 Everything。"),
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

  it("shows live scan counts while the background discovery is running", async () => {
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
        "正在扫描：已检查 42 个文件夹，发现 3 个今日文件。",
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
});
