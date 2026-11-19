import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProviderConfig, QizhiCommands } from "../../lib/tauri";
import { ModelProviderSettingsSection } from "./ModelProviderSettingsSection";

const providers: ModelProviderConfig[] = [
  {
    providerId: "openai",
    displayName: "OpenAI / OpenAI 兼容",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    apiKeyMask: "••••••••",
    supportsResponses: true,
    isActive: true,
    updatedAtUtcMs: 1,
  },
  {
    providerId: "ollama",
    displayName: "Ollama",
    endpoint: "http://localhost:11434/v1",
    model: "qwen3:8b",
    apiKeyMask: "",
    supportsResponses: false,
    isActive: false,
    updatedAtUtcMs: 0,
  },
];

describe("ModelProviderSettingsSection", () => {
  it("keeps provider configurations and activates exactly the selected provider", async () => {
    const saveModelProvider = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        ...providers[1],
        ...input,
        displayName: "Ollama",
        apiKeyMask: "",
      }),
    );
    const activateModelProvider = vi.fn().mockResolvedValue({
      ...providers[1],
      isActive: true,
    });
    const commands = {
      listModelProviders: vi.fn().mockResolvedValue(providers),
      saveModelProvider,
      testModelProvider: vi.fn().mockResolvedValue({
        available: true,
        message: "Ollama 连接正常，模型可用。",
      }),
      activateModelProvider,
      getActiveModelProvider: vi.fn().mockResolvedValue(providers[0]),
    } as Pick<
      QizhiCommands,
      | "listModelProviders"
      | "saveModelProvider"
      | "testModelProvider"
      | "activateModelProvider"
      | "getActiveModelProvider"
    >;

    render(
      <ModelProviderSettingsSection commands={commands as QizhiCommands} />,
    );
    const selector = await screen.findByLabelText("模型服务商");
    expect(
      screen.getByText("当前启用：OpenAI / OpenAI 兼容 · gpt-5.6-sol"),
    ).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: "ollama" } });
    expect(screen.getByLabelText("模型名称")).toHaveValue("qwen3:8b");
    expect(screen.getByLabelText("模型 API Key")).not.toBeRequired();

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(
      await screen.findByText("Ollama 连接正常，模型可用。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(saveModelProvider).toHaveBeenCalled());
    expect(activateModelProvider).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "启用此服务" }));
    await waitFor(() =>
      expect(activateModelProvider).toHaveBeenCalledWith("ollama"),
    );
  });
});
