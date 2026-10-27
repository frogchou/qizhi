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
    };

    render(<SettingsPage commands={commands} />);
    fireEvent.change(screen.getByLabelText("OpenAI API 地址"), {
      target: { value: "https://example.test/v1" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI API Key"), {
      target: { value: "test-secret-never-rendered" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(() => expect(commands.saveSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("test-secret-never-rendered"),
    ).not.toBeInTheDocument();
  });

  it("shows the privacy boundary and a redacted Everything remediation", async () => {
    const commands: QizhiCommands = {
      getSettings: vi.fn().mockResolvedValue([]),
      saveSettings: vi.fn(),
      testServiceConnection: vi.fn(),
      getEverythingStatus: vi.fn().mockResolvedValue({
        available: false,
        adapter: "unavailable",
        remediation: "未检测到 Everything，请安装并启动 Everything。",
      }),
    };

    render(<SettingsPage commands={commands} />);

    expect(screen.getByText(/系统目录.*始终被排除/)).toBeInTheDocument();
    expect(await screen.findByText(/未检测到 Everything/)).toBeInTheDocument();
  });
});
