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

  it("shows the privacy boundary and identifies Everything as optional", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn(),
      testServiceConnection: vi.fn(),
      pickFolder: vi.fn(),
      getTodaySnapshot: vi.fn(),
      refreshToday: vi.fn(),
      revealInExplorer: vi.fn(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: [],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        everythingSdkPath: null,
        esCliPath: null,
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
      getEverythingStatus: vi.fn().mockResolvedValue({
        available: false,
        adapter: "unavailable",
        remediation: "未检测到 Everything，请安装并启动 Everything。",
      }),
    };

    render(<SettingsPage commands={commands} />);

    expect(
      screen.getByText(/系统目录、AppData.*始终被排除/),
    ).toBeInTheDocument();
    expect(await screen.findByText("可选加速器")).toBeInTheDocument();
    expect(
      screen.getByText("不会影响“今日”发现本地文件。"),
    ).toBeInTheDocument();
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
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        everythingSdkPath: null,
        esCliPath: null,
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn().mockResolvedValue({}),
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
        esCliPath: null,
      }),
    );
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
});
