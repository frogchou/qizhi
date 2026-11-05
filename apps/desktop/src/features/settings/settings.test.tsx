import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands } from "../../lib/tauri";
import { SettingsPage } from "./SettingsPage";

function commandsForSummarySettings(): QizhiCommands {
  return {
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
      directoryGroupThreshold: 5,
      lockedExclusions: [],
    }),
    saveScanRules: vi.fn(),
  };
}

describe("SettingsPage", () => {
  it("loads and saves the Today directory grouping threshold", async () => {
    const commands = {
      ...commandsForSummarySettings(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        directoryGroupThreshold: 5,
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          ...input,
          lockedExclusions: [],
        }),
      ),
    } satisfies QizhiCommands;

    render(<SettingsPage commands={commands} />);
    const threshold = await screen.findByLabelText("目录聚合阈值");
    expect(threshold).toHaveValue(5);
    fireEvent.change(threshold, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "保存扫描范围" }));

    await waitFor(() =>
      expect(commands.saveScanRules).toHaveBeenCalledWith({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        directoryGroupThreshold: 10,
      }),
    );
  });

  it("keeps the grouping threshold and save action in dedicated layout regions", async () => {
    const commands = commandsForSummarySettings();
    render(<SettingsPage commands={commands} />);

    const threshold = await screen.findByLabelText("目录聚合阈值");
    const saveButton = screen.getByRole("button", { name: "保存扫描范围" });
    expect(threshold.closest(".threshold-setting-control")).not.toBeNull();
    expect(threshold.closest(".threshold-setting-row")).not.toBeNull();
    expect(saveButton.closest(".settings-block-actions")).not.toBeNull();
  });

  it("rejects directory grouping thresholds outside 2 through 100", async () => {
    const commands = {
      ...commandsForSummarySettings(),
      listScanRules: vi.fn().mockResolvedValue({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents"],
        directoryGroupThreshold: 5,
        lockedExclusions: [],
      }),
      saveScanRules: vi.fn(),
    } satisfies QizhiCommands;

    render(<SettingsPage commands={commands} />);
    const threshold = await screen.findByLabelText("目录聚合阈值");
    fireEvent.change(threshold, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存扫描范围" }));
    expect(
      await screen.findByText("目录聚合阈值必须在 2 到 100 之间。"),
    ).toBeInTheDocument();
    expect(commands.saveScanRules).not.toHaveBeenCalled();

    fireEvent.change(threshold, { target: { value: "101" } });
    fireEvent.click(screen.getByRole("button", { name: "保存扫描范围" }));
    expect(commands.saveScanRules).not.toHaveBeenCalled();
  });

  it("edits and saves reusable summary prompts outside the OpenAI service card", async () => {
    const client = {
      ...commandsForSummarySettings(),
      getSummarySettings: vi.fn().mockResolvedValue({
        model: "gpt-5.6",
        templates: [
          {
            id: 1,
            title: "今日工作总结",
            prompt: "总结成果。",
            sortOrder: 0,
            isDefault: true,
          },
        ],
      }),
      saveSummarySettings: vi
        .fn()
        .mockImplementation(
          (
            input: Parameters<
              NonNullable<QizhiCommands["saveSummarySettings"]>
            >[0],
          ) =>
            Promise.resolve({
              model: input.model,
              templates: input.templates.map((template, index) => ({
                ...template,
                id: index + 1,
              })),
            }),
        ),
    } satisfies QizhiCommands;

    render(<SettingsPage commands={client} />);
    const summaryHeading = await screen.findByRole("heading", {
      name: "今日总结",
    });
    expect(summaryHeading.closest(".summary-settings-section")).not.toBeNull();
    expect(summaryHeading.closest(".openai-card")).toBeNull();
    fireEvent.change(await screen.findByLabelText("总结模型"), {
      target: { value: "gpt-5.6-pro" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新增提示词" }));
    fireEvent.change(screen.getByLabelText("总结模板标题 2"), {
      target: { value: "管理层摘要" },
    });
    fireEvent.change(screen.getByLabelText("总结提示词 2"), {
      target: { value: "提炼结果、风险和下一步。" },
    });
    expect(screen.getByLabelText("总结模板标题 2")).toHaveAttribute(
      "maxlength",
      "60",
    );
    expect(screen.getByLabelText("总结提示词 2")).toHaveAttribute(
      "maxlength",
      "4000",
    );
    fireEvent.click(screen.getByRole("button", { name: "设为默认" }));
    fireEvent.click(screen.getByRole("button", { name: "保存今日总结设置" }));

    await waitFor(() => expect(client.saveSummarySettings).toHaveBeenCalled());
    expect(client.saveSummarySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-pro",
        templates: expect.arrayContaining([
          expect.objectContaining({
            title: "管理层摘要",
            prompt: "提炼结果、风险和下一步。",
            isDefault: true,
          }),
        ]),
      }),
    );
  });
  it("lets the user save the JEV instructions, score levels, and value threshold", async () => {
    const commands = {
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
      getJevValuePolicy: vi.fn().mockResolvedValue({
        instructions: "评估工作文件的长期知识价值。",
        criteria: ["噪声", "临时", "一般", "重要", "关键"],
        valuableThreshold: 2.5,
      }),
      saveJevValuePolicy: vi
        .fn()
        .mockImplementation((input) => Promise.resolve(input)),
    } satisfies QizhiCommands;

    render(<SettingsPage commands={commands} />);
    fireEvent.change(await screen.findByLabelText("JEV 评估说明"), {
      target: { value: "判断资料是否值得复用。" },
    });
    fireEvent.change(screen.getByLabelText("JEV 分级标准"), {
      target: { value: "无价值\n临时参考\n可复用" },
    });
    fireEvent.change(screen.getByLabelText("JEV 价值阈值"), {
      target: { value: "1.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存评估标准" }));

    await waitFor(() =>
      expect(commands.saveJevValuePolicy).toHaveBeenCalledWith({
        instructions: "判断资料是否值得复用。",
        criteria: ["无价值", "临时参考", "可复用"],
        valuableThreshold: 1.5,
      }),
    );
  });

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
        directoryGroupThreshold: 5,
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
