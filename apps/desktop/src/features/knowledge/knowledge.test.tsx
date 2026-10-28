import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands } from "../../lib/tauri";
import { KnowledgePage } from "./KnowledgePage";

function response() {
  return {
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
  };
}

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
    queryRagflowKnowledge: vi.fn().mockResolvedValue(response()),
  };
}

async function selectResources() {
  await screen.findByText("工作知识库");
  fireEvent.click(screen.getByText("知识库（0）"));
  fireEvent.click(screen.getByLabelText("工作知识库"));
  fireEvent.click(screen.getByText("Agents（0）"));
  fireEvent.click(screen.getByLabelText("工作助手"));
  fireEvent.click(screen.getByLabelText("评审助手"));
}

describe("KnowledgePage", () => {
  it("keeps retrieval and multiple Agent results in one conversation turn", async () => {
    const client = commands();
    render(<KnowledgePage commands={client} />);

    expect(
      await screen.findByRole("complementary", { name: "检索范围" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "知识库对话" }),
    ).toBeInTheDocument();
    await selectResources();

    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "项目进度" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    await waitFor(() =>
      expect(client.queryRagflowKnowledge).toHaveBeenCalledWith({
        question: "项目进度",
        datasetIds: ["kb-work"],
        agentIds: ["agent-work", "agent-review"],
      }),
    );
    expect(await screen.findByText("工作助手的回答")).toBeInTheDocument();
    expect(screen.getByText("Agent 暂不可用")).toBeInTheDocument();
    expect(screen.getByText("引用来源（1）")).toBeInTheDocument();
    fireEvent.click(screen.getByText("引用来源（1）"));
    expect(screen.getByText("周报中提到项目进度。")).toBeInTheDocument();
  });

  it("adds a follow-up question instead of replacing the existing conversation", async () => {
    const client = commands();
    render(<KnowledgePage commands={client} />);
    await selectResources();

    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "第一个问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await screen.findByText("工作助手的回答");

    fireEvent.change(screen.getByLabelText("继续提问"), {
      target: { value: "第二个问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    await waitFor(() =>
      expect(client.queryRagflowKnowledge).toHaveBeenCalledTimes(2),
    );
    expect(screen.getAllByText("第一个问题")[0]).toBeInTheDocument();
    expect(screen.getAllByText("第二个问题")[0]).toBeInTheDocument();
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
    expect(screen.getByText("RAGFlow 连接需要检查")).toBeInTheDocument();
  });
});
