import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  QizhiCommands,
  SummaryPromptTemplate,
  SummarySettingsInput,
} from "../../lib/tauri";
import { SummarySettingsSection } from "./SummarySettingsSection";

function templates(count: number): SummaryPromptTemplate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `提示词 ${index + 1}`,
    prompt: `请按方式 ${index + 1} 总结。`,
    sortOrder: index,
    isDefault: index === 0,
  }));
}

describe("SummarySettingsSection", () => {
  it("keeps a large prompt collection compact and can append another template", async () => {
    const savedTemplates = templates(20);
    const saveSummarySettings = vi.fn((input: SummarySettingsInput) =>
      Promise.resolve({
        model: input.model,
        templates: input.templates.map((template, index) => ({
          ...template,
          id: template.id ?? index + 100,
        })),
      }),
    );
    const commands = {
      getSummarySettings: vi.fn().mockResolvedValue({
        model: "gpt-5.6",
        templates: savedTemplates,
      }),
      saveSummarySettings,
    } as Pick<QizhiCommands, "getSummarySettings" | "saveSummarySettings">;

    render(<SummarySettingsSection commands={commands as QizhiCommands} />);

    expect(await screen.findByText("提示词 20")).toBeInTheDocument();
    expect(screen.queryByLabelText("总结提示词 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑 提示词 1" }));
    expect(screen.getByLabelText("总结提示词 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新增提示词" }));
    expect(screen.getByText("新总结方式")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存今日总结设置" }));

    await waitFor(() =>
      expect(commands.saveSummarySettings).toHaveBeenCalled(),
    );
    expect(commands.saveSummarySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        templates: expect.arrayContaining([
          expect.objectContaining({ title: "新总结方式" }),
        ]),
      }),
    );
    expect(saveSummarySettings.mock.calls[0][0].templates).toHaveLength(21);
  });
});
