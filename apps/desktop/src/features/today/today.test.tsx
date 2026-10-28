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
    fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
    await waitFor(() => expect(client.refreshToday).toHaveBeenCalledTimes(1));
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
});
