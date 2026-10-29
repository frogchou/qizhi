import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands } from "../../lib/tauri";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  it("sends a new key once and only displays its masked returned value", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn().mockResolvedValue({
        service: "openai",
        endpoint: "https://example.test/v1",
        apiKeyMask: "••••••••",
        credentialReference: "qizhi/openai/default",
      }),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn(),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      openFile: vi.fn(),
      openFileInTextEditor: vi.fn(),
      copyFileToClipboard: vi.fn(),
      deleteFile: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: [],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
    };

    render(<SettingsPage commands={commands} />);
    fireEvent.change(screen.getByLabelText("OpenAI Base URL"), {
      target: { value: "https://example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI API Key"), {
      target: { value: "test-secret-never-rendered" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(commands.saveSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByPlaceholderText("••••••••")).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("test-secret-never-rendered"),
    ).not.toBeInTheDocument();
  });

  it("shows the privacy boundary and identifies the built-in NTFS indexer", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn(),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn(),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      openFile: vi.fn(),
      openFileInTextEditor: vi.fn(),
      copyFileToClipboard: vi.fn(),
      deleteFile: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: [],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
      getNtfsIndexerStatus: vi.fn().mockResolvedValue({
        available: true,
        message: "本地 NTFS 索引服务已连接。",
      }),
    };

    render(<SettingsPage commands={commands} />);

    expect(
      screen.getByText(/系统目录、AppData.*始终被排除/),
    ).toBeInTheDocument();
    expect(await screen.findByText("本地 NTFS 索引器")).toBeInTheDocument();
    expect(screen.getByText("无需启动或安装 Everything。")).toBeInTheDocument();
  });

  it("adds a folder selected from the system picker to the scan roots", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn(),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn().mockResolvedValue("D:\\Work"),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      openFile: vi.fn(),
      openFileInTextEditor: vi.fn(),
      copyFileToClipboard: vi.fn(),
      deleteFile: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: [],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
    };

    render(<SettingsPage commands={commands} />);
    fireEvent.click(screen.getAllByRole("button", { name: "添加文件夹" })[0]);

    expect(commands.pickFolder).toHaveBeenCalledOnce();
    expect(await screen.findByText("D:\\Work")).toBeInTheDocument();
  });

  it("saves the selected supported file categories as part of scan rules", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn(),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn(),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      openFile: vi.fn(),
      openFileInTextEditor: vi.fn(),
      copyFileToClipboard: vi.fn(),
      deleteFile: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn().mockResolvedValue({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents"],
        lockedExclusions: [],
      }),
    };

    render(<SettingsPage commands={commands} />);
    await screen.findByText("文件类型");
    fireEvent.click(screen.getByLabelText(/常见编程语言源码/));
    fireEvent.click(screen.getByRole("button", { name: "保存扫描范围" }));

    await waitFor(() =>
      expect(commands.saveScanRules).toHaveBeenCalledWith({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents"],
      }),
    );
    expect(
      await screen.findByText("扫描规则已保存：1 个扫描范围，0 个排除目录。"),
    ).toBeInTheDocument();
  });

  it("saves RAGFlow as a separately masked connection", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn().mockResolvedValue({
        service: "ragflow",
        endpoint: "http://ragflow.example.test",
        apiKeyMask: "••••••••",
        credentialReference: "qizhi/ragflow/default",
      }),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn(),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      openFile: vi.fn(),
      openFileInTextEditor: vi.fn(),
      copyFileToClipboard: vi.fn(),
      deleteFile: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: [],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
    };

    render(<SettingsPage commands={commands} />);
    fireEvent.change(screen.getByLabelText("RAGFlow Base URL"), {
      target: { value: "http://ragflow.example.test" },
    });
    fireEvent.change(screen.getByLabelText("RAGFlow API Key"), {
      target: { value: "ragflow-secret-never-rendered" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 RAGFlow" }));

    await waitFor(() =>
      expect(commands.saveSettings).toHaveBeenCalledWith({
        service: "ragflow",
        endpoint: "http://ragflow.example.test",
        apiKey: "ragflow-secret-never-rendered",
      }),
    );
    expect(
      screen.queryByDisplayValue("ragflow-secret-never-rendered"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("RAGFlow 设置已保存，可前往知识库加载机器人。"),
    ).toBeInTheDocument();
  });

  it("shows a normal Windows path when legacy settings contain an extended path", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn(),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn(),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      openFile: vi.fn(),
      openFileInTextEditor: vi.fn(),
      copyFileToClipboard: vi.fn(),
      deleteFile: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: [String.raw`\\?\C:\Users\fcc\Documents`],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
    };

    render(<SettingsPage commands={commands} />);

    expect(
      await screen.findByText(String.raw`C:\Users\fcc\Documents`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\\\\\?\\/)).not.toBeInTheDocument();
  });
});
