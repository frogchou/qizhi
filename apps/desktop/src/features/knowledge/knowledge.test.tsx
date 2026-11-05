import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { QizhiCommands } from "../../lib/tauri";
import { KnowledgePage } from "./KnowledgePage";

const { saveDialog } = vi.hoisted(() => ({ saveDialog: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveDialog }));

function response() {
  return {
    chunks: [
      {
        id: "chunk-1",
        content: "周报中提到项目进度。",
        documentName: "周报.docx",
        documentId: "document-1",
        datasetId: "kb-work",
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
    downloadRagflowDocument: vi.fn().mockResolvedValue({
      savedPath: "C:\\Users\\fcc\\Downloads\\周报.docx",
    }),
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
  it("keeps multiple retrieval chunks selected in React StrictMode", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn().mockResolvedValue({
      chunks: [
        {
          id: "chunk-1",
          content: "第一条片段",
          documentName: "第一份资料.docx",
          documentId: "document-1",
          datasetId: "kb-work",
          similarity: 0.91,
        },
        {
          id: "chunk-2",
          content: "第二条片段",
          documentName: "第二份资料.pdf",
          documentId: "document-2",
          datasetId: "kb-work",
          similarity: 0.88,
        },
      ],
      retrievalError: null,
      agentResults: [],
    });

    render(
      <StrictMode>
        <KnowledgePage commands={client} />
      </StrictMode>,
    );
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "查找相关资料" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    fireEvent.click(await screen.findByText("引用来源（2）"));

    const first = screen.getByLabelText("选择片段 第一份资料.docx");
    const second = screen.getByLabelText("选择片段 第二份资料.pdf");
    fireEvent.click(first);
    fireEvent.click(second);

    expect(first).toBeChecked();
    expect(second).toBeChecked();
    expect(screen.getByText("已选 2 条片段")).toBeInTheDocument();
  });

  it("sends only selected retrieval chunks to Codex without clearing the conversation", async () => {
    const client = commands();
    client.prepareCodexHandoff = vi.fn().mockResolvedValue({
      preparationId: "prepared-chunks",
      sourceKind: "ragflow_chunks",
      fileCount: 1,
      totalSizeBytes: 100,
      previewItems: [{ fileId: -1, displayName: "周报.docx", sizeBytes: 100 }],
      blockedItems: [],
      warningItems: [],
      requiresLargeFileConfirmation: false,
    });
    client.listCodexProjects = vi.fn().mockResolvedValue([
      {
        id: "p1",
        name: "分析项目",
        goal: null,
        rootPath: "managed",
        status: "active",
        createdAtUtcMs: 1,
        updatedAtUtcMs: 1,
        lastOpenedAtUtcMs: 1,
      },
    ]);
    client.listCodexConversations = vi.fn().mockResolvedValue([
      {
        id: "c1",
        projectId: "p1",
        title: "分析会话",
        codexThreadId: null,
        codexSessionId: null,
        status: "draft",
        createdAtUtcMs: 1,
        updatedAtUtcMs: 1,
        archivedAtUtcMs: null,
      },
    ]);
    client.commitCodexHandoff = vi.fn().mockResolvedValue({
      handoffId: "h1",
      projectId: "p1",
      conversationId: "c1",
      itemCount: 1,
      status: "ready",
    });
    const onOpenCodex = vi.fn();
    render(<KnowledgePage commands={client} onOpenCodex={onOpenCodex} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "项目进度" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    fireEvent.click(await screen.findByText("引用来源（1）"));
    fireEvent.click(screen.getByLabelText("选择片段 周报.docx"));
    fireEvent.click(
      screen.getByRole("button", { name: "发送所选片段到 Codex" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "发送资料到 Codex" }),
    ).toBeInTheDocument();
    expect(client.prepareCodexHandoff).toHaveBeenCalledWith({
      source: {
        kind: "ragflowChunks",
        question: "项目进度",
        chunks: [
          expect.objectContaining({
            chunkId: "chunk-1",
            documentId: "document-1",
            datasetId: "kb-work",
            content: "周报中提到项目进度。",
          }),
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("项目会话")).toHaveValue("c1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "发送并打开 Codex" }));
    await waitFor(() => expect(onOpenCodex).toHaveBeenCalledTimes(1));
    expect(screen.getByText("工作助手的回答")).toBeInTheDocument();
  });

  it("sends one Agent final answer and its citations but never its execution steps", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn().mockResolvedValue({
      chunks: [],
      retrievalError: null,
      agentResults: [
        {
          agentId: "agent-work",
          answer: "最终回答。[ID:315]",
          error: null,
          sessionId: "session-1",
          sessionInvalid: false,
          steps: [
            {
              title: "内部搜索步骤",
              nodeType: "retrieval",
              status: "completed",
              elapsedMs: 8,
              error: null,
            },
          ],
          references: [
            {
              citationId: "315",
              chunkId: "chunk-315",
              content: "引用片段",
              documentName: "人员名单.docx",
              documentId: "doc-315",
              datasetId: "kb-work",
              similarity: 0.9,
              docType: "docx",
              positions: [],
              documentMetadata: {},
              url: "",
            },
          ],
          sources: [
            {
              documentName: "人员名单.docx",
              documentId: "doc-315",
              datasetId: "kb-work",
              citationCount: 1,
            },
          ],
        },
      ],
    });
    client.prepareCodexHandoff = vi.fn().mockResolvedValue({
      preparationId: "prepared-answer",
      sourceKind: "ragflow_answer",
      fileCount: 1,
      totalSizeBytes: 80,
      previewItems: [
        { fileId: -1, displayName: "工作助手 的回答.md", sizeBytes: 80 },
      ],
      blockedItems: [],
      warningItems: [],
      requiresLargeFileConfirmation: false,
    });
    client.listCodexProjects = vi.fn().mockResolvedValue([]);
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "王某是谁" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "发送 工作助手 回答到 Codex" }),
    );
    await screen.findByRole("dialog", { name: "发送资料到 Codex" });
    const call = vi.mocked(client.prepareCodexHandoff!).mock.calls[0][0];
    expect(call.source).toMatchObject({
      kind: "ragflowAnswer",
      answer: {
        question: "王某是谁",
        agentId: "agent-work",
        agentName: "工作助手",
        finalAnswer: "最终回答。[ID:315]",
        references: [
          expect.objectContaining({ citationId: "315", chunkId: "chunk-315" }),
        ],
      },
    });
    expect(JSON.stringify(call)).not.toContain("内部搜索步骤");
  });

  it("keeps retrieval and multiple Agent results in one conversation turn", async () => {
    const client = commands();
    saveDialog.mockResolvedValue("C:\\Users\\fcc\\Downloads\\周报.docx");
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
      expect(client.queryRagflowKnowledge).toHaveBeenCalledWith(
        {
          question: "项目进度",
          datasetIds: ["kb-work"],
          agentIds: ["agent-work", "agent-review"],
          agentSessions: {},
        },
        expect.any(Function),
      ),
    );
    expect(await screen.findByText("工作助手的回答")).toBeInTheDocument();
    expect(screen.getByText("Agent 暂不可用")).toBeInTheDocument();
    expect(screen.getByText("引用来源（1）")).toBeInTheDocument();
    fireEvent.click(screen.getByText("引用来源（1）"));
    expect(screen.getByText("周报中提到项目进度。")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "下载 周报.docx" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载 周报.docx" }));
    await waitFor(() =>
      expect(client.downloadRagflowDocument).toHaveBeenCalledWith({
        datasetId: "kb-work",
        documentId: "document-1",
        savePath: "C:\\Users\\fcc\\Downloads\\周报.docx",
      }),
    );
  });

  it("keeps the composer available at the bottom before a conversation starts", async () => {
    render(<KnowledgePage commands={commands()} />);

    await screen.findByText("工作知识库");
    expect(document.querySelector(".conversation-follow-up")).toBeTruthy();
  });

  it("wraps an unbroken Agent response without adding a horizontal conversation scrollbar", async () => {
    const client = commands();
    const longResponse = "x".repeat(120);
    client.queryRagflowKnowledge = vi.fn().mockResolvedValue({
      chunks: [],
      agentResults: [
        { agentId: "agent-work", answer: longResponse, error: null },
      ],
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();

    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "超长回答" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    await waitFor(() =>
      expect(document.querySelector(".knowledge-answer")).toBeInTheDocument(),
    );
    const answer = document.querySelector(".knowledge-answer");
    if (!answer) throw new Error("未渲染 Agent 回答");
    expect(answer.textContent).toBe(longResponse);
    expect(answer.querySelectorAll("wbr")).toHaveLength(2);
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

  it("streams Agent answers into a left response while the user message stays right aligned", async () => {
    const client = commands();
    let finish!: (value: ReturnType<typeof response>) => void;
    client.queryRagflowKnowledge = vi.fn((_, onEvent) => {
      onEvent?.({ kind: "agentStarted", agentId: "agent-work" });
      onEvent?.({ kind: "agentDelta", agentId: "agent-work", delta: "流式" });
      onEvent?.({ kind: "agentDelta", agentId: "agent-work", delta: "回答" });
      return new Promise<ReturnType<typeof response>>((resolve) => {
        finish = resolve;
      });
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();

    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "流式问题" },
    });
    fireEvent.keyDown(screen.getByLabelText("询问你的工作知识库"), {
      key: "Enter",
      shiftKey: false,
    });

    expect(await screen.findByText("流式回答")).toBeInTheDocument();
    expect(screen.getAllByText("流式问题")[0].closest("article")).toHaveClass(
      "user-message",
    );
    expect(screen.getByText("流式回答").closest("section")).toHaveClass(
      "agent-answer",
    );
    finish(response());
  });

  it("copies raw Markdown and edits messages by replacing only the composer", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn((_, onEvent) => {
      onEvent?.({ kind: "agentStarted", agentId: "agent-work" });
      onEvent?.({
        kind: "agentDelta",
        agentId: "agent-work",
        delta: "**加粗回答**",
      });
      return Promise.resolve({
        chunks: [],
        retrievalError: null,
        agentResults: [
          {
            agentId: "agent-work",
            answer: "**加粗回答**",
            error: null,
            sessionId: "session-1",
            sessionInvalid: false,
            steps: [],
          },
        ],
      });
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "原问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    await screen.findByText("加粗回答");
    fireEvent.click(screen.getByRole("button", { name: "复制 工作助手 回答" }));
    expect(writeText).toHaveBeenCalledWith("**加粗回答**");
    fireEvent.change(screen.getByLabelText("继续提问"), {
      target: { value: "草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑 原问题" }));
    expect(screen.getByLabelText("继续提问")).toHaveValue("原问题");
    expect(screen.getAllByText("原问题")[0]).toBeInTheDocument();
  });

  it("keeps verified Agent steps collapsed and never renders private thinking text", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn((_, onEvent) => {
      onEvent?.({ kind: "agentStarted", agentId: "agent-work" });
      onEvent?.({ kind: "agentThinking", agentId: "agent-work", active: true });
      onEvent?.({
        kind: "agentStep",
        agentId: "agent-work",
        step: {
          title: "检索资料",
          nodeType: "retrieval",
          status: "completed",
          elapsedMs: 120,
          error: null,
        },
      });
      onEvent?.({
        kind: "agentDelta",
        agentId: "agent-work",
        delta: "最终答案",
      });
      return Promise.resolve({
        chunks: [],
        agentResults: [
          {
            agentId: "agent-work",
            answer: "最终答案",
            error: null,
            sessionId: null,
            sessionInvalid: false,
            steps: [
              {
                title: "检索资料",
                nodeType: "retrieval",
                status: "completed",
                elapsedMs: 120,
                error: null,
              },
            ],
          },
        ],
      });
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "查资料" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    const details = await screen.findByText("思考与执行过程（1）");
    expect(details.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("private thinking")).not.toBeInTheDocument();
  });

  it("renders Agent citation markers as hoverable evidence and lists source documents", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn().mockResolvedValue({
      chunks: [],
      retrievalError: null,
      agentResults: [
        {
          agentId: "agent-work",
          answer: "王某是项目负责人。[ID:315]",
          error: null,
          sessionId: "session-1",
          sessionInvalid: false,
          steps: [],
          references: [
            {
              citationId: "315",
              chunkId: "chunk-1",
              content: "人员名单中记录了项目负责人的岗位信息。",
              documentName: "人员名单.docx",
              documentId: "document-1",
              datasetId: "kb-work",
              similarity: 0.93,
              docType: "docx",
              positions: [[1, 2, 3, 4, 5]],
              documentMetadata: { department: "研发部" },
              url: "",
            },
          ],
          sources: [
            {
              documentName: "人员名单.docx",
              documentId: "document-1",
              datasetId: "kb-work",
              citationCount: 1,
            },
          ],
        },
      ],
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "王某是谁" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    const marker = await screen.findByRole("button", {
      name: "查看引用 Fig.315",
    });
    expect(marker).toHaveTextContent("Fig.315");
    fireEvent.mouseEnter(marker);
    expect(
      screen.getByText("人员名单中记录了项目负责人的岗位信息。"),
    ).toBeInTheDocument();
    expect(screen.getByText("引用资料（1）")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "下载来源 人员名单.docx" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("[ID:315]", { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("uses Enter to send, Shift+Enter for a newline, and ignores IME confirmation", async () => {
    const client = commands();
    render(<KnowledgePage commands={client} />);
    await selectResources();
    const input = screen.getByLabelText("询问你的工作知识库");
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(client.queryRagflowKnowledge).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(client.queryRagflowKnowledge).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(client.queryRagflowKnowledge).toHaveBeenCalledTimes(1),
    );
  });

  it("continues each selected Agent with its own session on a follow-up", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [],
        retrievalError: null,
        agentResults: [
          {
            agentId: "agent-work",
            answer: "第一轮回答",
            error: null,
            sessionId: "session-work",
            sessionInvalid: false,
            steps: [],
          },
          {
            agentId: "agent-review",
            answer: "第一轮评审",
            error: null,
            sessionId: "session-review",
            sessionInvalid: false,
            steps: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        chunks: [],
        retrievalError: null,
        agentResults: [],
      });
    render(<KnowledgePage commands={client} />);
    await selectResources();

    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "第一轮" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await screen.findByText("第一轮回答");
    fireEvent.change(screen.getByLabelText("继续提问"), {
      target: { value: "继续" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    await waitFor(() =>
      expect(client.queryRagflowKnowledge).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentSessions: {
            "agent-work": "session-work",
            "agent-review": "session-review",
          },
        }),
        expect.any(Function),
      ),
    );
  });

  it("ignores late stream events after the final snapshot becomes authoritative", async () => {
    const client = commands();
    let streamEvent!: Parameters<
      NonNullable<QizhiCommands["queryRagflowKnowledge"]>
    >[1];
    client.queryRagflowKnowledge = vi.fn((_, onEvent) => {
      streamEvent = onEvent;
      return Promise.resolve({
        chunks: [],
        retrievalError: null,
        agentResults: [
          {
            agentId: "agent-work",
            answer: "最终快照",
            error: null,
            sessionId: null,
            sessionInvalid: false,
            steps: [],
          },
          {
            agentId: "agent-review",
            answer: "评审快照",
            error: null,
            sessionId: null,
            sessionInvalid: false,
            steps: [],
          },
        ],
      });
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "最终状态" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await screen.findByText("最终快照");

    act(() => {
      streamEvent?.({ kind: "retrievalFailed", error: "迟到的检索错误" });
      streamEvent?.({
        kind: "agentDelta",
        agentId: "agent-work",
        delta: "不应追加",
      });
    });

    await waitFor(() =>
      expect(screen.queryByText(/迟到的检索错误/)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("最终快照不应追加")).not.toBeInTheDocument();
  });

  it("marks every unfinished Agent and the turn as failed when the query aborts", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn((_, onEvent) => {
      onEvent?.({ kind: "agentStarted", agentId: "agent-work" });
      return Promise.reject(new Error("连接中断"));
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "失败场景" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(
      await screen.findByText(/本轮问答未完成：连接中断/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("未完成")).toHaveLength(2);
    expect(screen.queryByText("生成中")).not.toBeInTheDocument();
  });

  it("does not report success when retrieval and every Agent fail", async () => {
    const client = commands();
    client.queryRagflowKnowledge = vi.fn().mockResolvedValue({
      chunks: [],
      retrievalError: "检索失败",
      agentResults: [
        { agentId: "agent-work", answer: null, error: "工作助手失败" },
        { agentId: "agent-review", answer: null, error: "评审助手失败" },
      ],
    });
    render(<KnowledgePage commands={client} />);
    await selectResources();
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "全部失败" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(
      await screen.findByText(/所选知识库和 Agents 均未能返回结果/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("未完成")).toHaveLength(2);
  });
});
