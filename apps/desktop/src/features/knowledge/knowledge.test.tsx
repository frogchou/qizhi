import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands } from "../../lib/tauri";
import { KnowledgePage } from "./KnowledgePage";

function commands(): QizhiCommands {
  return {
    getSettings: vi.fn(),
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
    listScanRules: vi.fn(),
    saveScanRules: vi.fn(),
    listRagflowDatasets: vi
      .fn()
      .mockResolvedValue([
        { id: "kb-work", name: "工作知识库", description: "项目资料" },
      ]),
    listRagflowAgents: vi.fn().mockResolvedValue([
      { id: "agent-work", name: "工作助手", description: "项目分析" },
      { id: "agent-review", name: "评审助手", description: "风险分析" },
    ]),
    queryRagflowKnowledge: vi.fn().mockResolvedValue({
      chunks: [
        {
          id: "chunk-1",
          content: "周报中提到项目进度。",
          documentName: "周报.docx",
          similarity: 0.91,
        },
      ],
      agentResults: [
        { agentId: "agent-work", answer: "工作助手的回答", error: null },
        { agentId: "agent-review", answer: null, error: "Agent 暂不可用" },
      ],
    }),
  };
}

describe("KnowledgePage", () => {
  it("queries selected datasets and multiple Agents in one workspace", async () => {
    const client = commands();
    render(<KnowledgePage commands={client} />);
    expect(await screen.findByText("工作助手")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("工作知识库"));
    fireEvent.click(screen.getByLabelText("工作助手"));
    fireEvent.click(screen.getByLabelText("评审助手"));
    fireEvent.change(screen.getByLabelText("关键词或问题"), {
      target: { value: "项目进度" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() =>
      expect(client.queryRagflowKnowledge).toHaveBeenCalledWith({
        question: "项目进度",
        datasetIds: ["kb-work"],
        agentIds: ["agent-work", "agent-review"],
      }),
    );
    expect(await screen.findByText("周报中提到项目进度。")).toBeInTheDocument();
    expect(await screen.findByText("工作助手的回答")).toBeInTheDocument();
    expect(await screen.findByText("Agent 暂不可用")).toBeInTheDocument();
  });
  it("explains how to continue when RAGFlow is not configured", async () => {
    const client = commands();
    client.listRagflowDatasets = vi
      .fn()
      .mockRejectedValue(
        new Error("请先在设置中保存 RAGFlow Base URL 和 API Key。"),
      );
    render(<KnowledgePage commands={client} />);
    expect(
      await screen.findByText("请先在设置中保存 RAGFlow Base URL 和 API Key。"),
    ).toBeInTheDocument();
  });
});
