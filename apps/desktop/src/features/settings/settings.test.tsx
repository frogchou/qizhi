import { render } from "../../test/render";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProviderConfig, QizhiCommands } from "../../lib/tauri";
import { SettingsPage } from "./SettingsPage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function commandsForSummarySettings(): QizhiCommands {
  const provider: ModelProviderConfig = {
    providerId: "openai",
    displayName: "OpenAI / OpenAI 兼容",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    apiKeyMask: "••••••••",
    supportsResponses: true,
    isActive: true,
    updatedAtUtcMs: 1,
  };
  return {
    getSettings: vi.fn().mockResolvedValue([]),
    saveSettings: vi.fn(),
    testServiceConnection: vi.fn(),
    listModelProviders: vi.fn().mockResolvedValue([provider]),
    getActiveModelProvider: vi.fn().mockResolvedValue(provider),
    saveModelProvider: vi
      .fn()
      .mockImplementation((input) =>
        Promise.resolve({ ...provider, ...input, apiKeyMask: "••••••••" }),
      ),
    testModelProvider: vi.fn(),
    activateModelProvider: vi.fn().mockResolvedValue(provider),
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
  it("selects and resets the Codex executable on a Mac", async () => {
    const path = "/opt/homebrew/bin/codex";
    const saveCodexExecutablePath = vi.fn(
      async (value: string | null) => value,
    );
    render(
      <SettingsPage
        commands={{
          ...commandsForSummarySettings(),
          desktopPlatform: "macos",
          getCodexExecutablePath: vi.fn().mockResolvedValue(null),
          pickCodexExecutable: vi.fn().mockResolvedValue(path),
          saveCodexExecutablePath,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex 工作" }));
    fireEvent.click(screen.getByRole("button", { name: "选择 Codex 程序" }));
    expect(await screen.findByText(`Codex 程序 · ${path}`)).toBeVisible();
    expect(saveCodexExecutablePath).toHaveBeenCalledWith(path);
    fireEvent.click(screen.getByRole("button", { name: "恢复自动查找" }));
    expect(
      await screen.findByText("Codex 程序 · 从本机自动查找"),
    ).toBeVisible();
    expect(saveCodexExecutablePath).toHaveBeenLastCalledWith(null);
  });

  it("shows one settings category at a time and marks the active navigation item", async () => {
    render(<SettingsPage commands={commandsForSummarySettings()} />);

    const navigation = await screen.findByRole("navigation", {
      name: "设置分类",
    });
    expect(navigation).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "扫描与隐私" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "连接服务" })).toBeVisible();
    expect(screen.getByRole("button", { name: "价值评估" })).toBeVisible();
    expect(screen.getByRole("button", { name: "今日总结" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Codex 工作" })).toBeVisible();

    expect(
      document.getElementById("settings-panel-privacy"),
    ).not.toHaveAttribute("hidden");
    expect(document.getElementById("settings-panel-services")).toHaveAttribute(
      "hidden",
    );

    fireEvent.click(screen.getByRole("button", { name: "连接服务" }));

    expect(screen.getByRole("button", { name: "连接服务" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.getElementById("settings-panel-privacy")).toHaveAttribute(
      "hidden",
    );
    expect(
      document.getElementById("settings-panel-services"),
    ).not.toHaveAttribute("hidden");
  });

  it("preserves unsaved drafts while switching settings categories", async () => {
    render(<SettingsPage commands={commandsForSummarySettings()} />);

    fireEvent.click(await screen.findByRole("button", { name: "连接服务" }));
    const baseUrl = await screen.findByLabelText("模型 Base URL");
    fireEvent.change(baseUrl, {
      target: { value: "https://draft.example.test/v1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "扫描与隐私" }));
    fireEvent.click(screen.getByRole("button", { name: "连接服务" }));

    expect(screen.getByLabelText("模型 Base URL")).toHaveValue(
      "https://draft.example.test/v1",
    );
  });

  it("does not change category when asynchronous settings finish loading", async () => {
    const providers = deferred<ModelProviderConfig[]>();
    const commands = {
      ...commandsForSummarySettings(),
      listModelProviders: vi.fn().mockReturnValue(providers.promise),
    } satisfies QizhiCommands;
    render(<SettingsPage commands={commands} />);

    fireEvent.click(await screen.findByRole("button", { name: "今日总结" }));
    providers.resolve([
      {
        providerId: "openai",
        displayName: "OpenAI / OpenAI 兼容",
        endpoint: "https://loaded.example.test/v1",
        model: "gpt-5.6-sol",
        apiKeyMask: "••••••••",
        supportsResponses: true,
        isActive: true,
        updatedAtUtcMs: 1,
      },
    ]);

    await waitFor(() =>
      expect(screen.getByLabelText("模型 Base URL")).toHaveValue(
        "https://loaded.example.test/v1",
      ),
    );
    expect(screen.getByRole("button", { name: "今日总结" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

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
      getActiveModelProvider: vi.fn().mockResolvedValue({
        providerId: "openai",
        displayName: "OpenAI / OpenAI 兼容",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5.6-pro",
        apiKeyMask: "••••••••",
        supportsResponses: true,
        isActive: true,
        updatedAtUtcMs: 1,
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
    fireEvent.click(await screen.findByRole("button", { name: "今日总结" }));
    const summaryHeading = await screen.findByRole("heading", {
      name: "今日总结",
    });
    expect(summaryHeading.closest(".summary-settings-section")).not.toBeNull();
    expect(summaryHeading.closest(".openai-card")).toBeNull();
    expect(await screen.findByText("gpt-5.6-pro")).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "价值评估" }));
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
    const provider: ModelProviderConfig = {
      providerId: "openai",
      displayName: "OpenAI / OpenAI 兼容",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      apiKeyMask: "",
      supportsResponses: true,
      isActive: false,
      updatedAtUtcMs: 0,
    };
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn().mockResolvedValue({
        service: "openai",
        endpoint: "https://example.test/v1",
        apiKeyMask: "••••••••",
        credentialReference: "qizhi/openai/default",
      }),
      testServiceConnection: vi.fn(),
      listModelProviders: vi.fn().mockResolvedValue([provider]),
      saveModelProvider: vi.fn().mockImplementation((input) =>
        Promise.resolve({
          ...provider,
          ...input,
          apiKeyMask: "••••••••",
          updatedAtUtcMs: 2,
        }),
      ),
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
    fireEvent.click(await screen.findByRole("button", { name: "连接服务" }));
    fireEvent.change(await screen.findByLabelText("模型 Base URL"), {
      target: { value: "https://example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型 API Key"), {
      target: { value: "test-secret-never-rendered" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(commands.saveModelProvider).toHaveBeenCalledTimes(1),
    );
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

  it("keeps legacy image discovery disabled and persists the image search switch", async () => {
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

    const imageSearch = await screen.findByLabelText("在今日和过去中发现图片");
    expect(imageSearch).not.toBeChecked();

    fireEvent.click(imageSearch);
    fireEvent.click(screen.getByRole("button", { name: "保存扫描范围" }));
    await waitFor(() =>
      expect(commands.saveScanRules).toHaveBeenLastCalledWith({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode", "images"],
        directoryGroupThreshold: 5,
      }),
    );
    expect(await screen.findByText(/图片搜索已开启/)).toBeInTheDocument();

    fireEvent.click(imageSearch);
    fireEvent.click(screen.getByRole("button", { name: "保存扫描范围" }));
    await waitFor(() =>
      expect(commands.saveScanRules).toHaveBeenLastCalledWith({
        allowedRoots: ["D:\\Work"],
        customExclusions: [],
        fileCategories: ["documents", "sourceCode"],
        directoryGroupThreshold: 5,
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
    fireEvent.click(await screen.findByRole("button", { name: "连接服务" }));
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
