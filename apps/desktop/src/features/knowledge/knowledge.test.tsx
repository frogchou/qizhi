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
    listScanRules: vi.fn(),
    saveScanRules: vi.fn(),
    listRagflowChats: vi.fn().mockResolvedValue([
      { id: "chat-work", name: "工作知识库", description: "工作资料问答" },
      { id: "chat-policy", name: "制度知识库", description: "制度问答" },
    ]),
    askRagflowChat: vi.fn().mockResolvedValue({
      answer: "这是来自工作知识库的回答。",
      sessionId: "session-1",
    }),
  };
}

describe("KnowledgePage", () => {
  it("selects a RAGFlow assistant and sends a question", async () => {
    const client = commands();
    render(<KnowledgePage commands={client} />);

    expect(await screen.findByText("工作知识库")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("问题"), {
      target: { value: "今天的工作重点是什么？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(client.askRagflowChat).toHaveBeenCalledWith({
        chatId: "chat-work",
        question: "今天的工作重点是什么？",
      }),
    );
    expect(
      await screen.findByText("这是来自工作知识库的回答。"),
    ).toBeInTheDocument();
  });

  it("explains how to continue when RAGFlow is not configured", async () => {
    const client = commands();
    client.listRagflowChats = vi
      .fn()
      .mockRejectedValue(
        new Error("请先在设置中保存 RAGFlow Base URL 和 API Key。"),
      );
    render(<KnowledgePage commands={client} />);

    expect(
      await screen.findByText("请先在设置中保存 RAGFlow Base URL 和 API Key。"),
    ).toBeInTheDocument();
  });

  it("shows the actual RAGFlow error and lets the user retry loading assistants", async () => {
    const client = commands();
    const listChats = vi
      .fn()
      .mockRejectedValueOnce(new Error("RAGFlow 连接未通过（HTTP 401）。"))
      .mockResolvedValueOnce([
        { id: "chat-work", name: "工作知识库", description: "工作资料问答" },
      ]);
    client.listRagflowChats = listChats;
    render(<KnowledgePage commands={client} />);

    expect(
      await screen.findByText("RAGFlow 连接未通过（HTTP 401）。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("请先在设置中保存 RAGFlow Base URL 和 API Key。"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新加载机器人" }));
    await waitFor(() => expect(listChats).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("工作知识库")).toBeInTheDocument();
  });

  it("clears an answer when the user changes the selected assistant", async () => {
    const client = commands();
    render(<KnowledgePage commands={client} />);
    await screen.findByText("工作知识库");
    fireEvent.change(screen.getByLabelText("问题"), {
      target: { value: "先问一次" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("这是来自工作知识库的回答。");

    fireEvent.change(screen.getByLabelText("选择问答机器人"), {
      target: { value: "chat-policy" },
    });

    expect(
      screen.queryByText("这是来自工作知识库的回答。"),
    ).not.toBeInTheDocument();
  });
});
