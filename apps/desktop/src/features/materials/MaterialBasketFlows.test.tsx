import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  unavailableCommands,
  type QizhiCommands,
  type CodexHandoffDetails,
  type TodaySnapshot,
} from "../../lib/tauri";
import { TodayPage } from "../today/TodayPage";
import { KnowledgePage } from "../knowledge/KnowledgePage";
import { CodexPage } from "../codex/CodexPage";
import { MaterialBasketProvider } from "./MaterialBasket";
import type { BasketItem } from "./basket-types";
const item: BasketItem = {
  id: "basket-1",
  kind: "local",
  displayName: "调研记录.md",
  sourceLabel: "本机",
  sizeBytes: 55,
  sha256: "a",
  addedAtUtcMs: 1,
};
function basket(): QizhiCommands {
  return {
    ...unavailableCommands,
    listBasket: vi.fn(async () => [item]),
    addToBasket: vi.fn(async () => [
      {
        key: item.id,
        status: "added" as const,
        item,
        displayName: item.displayName,
        error: null,
      },
    ]),
  };
}
describe("资料筐的来源与会话", () => {
  it("今日/近期按真实查询及选中的文件编号入筐，保留勾选", async () => {
    const commands = basket(),
      snapshot: TodaySnapshot = {
        state: "ready",
        files: [
          {
            id: 7,
            canonicalPath: "D:\\test\\调研记录.md",
            modifiedAtUtcMs: 1,
            sizeBytes: 12,
            source: "本机",
            status: "待分析",
          },
        ],
        clusters: [],
      };
    commands.getTodaySnapshot = vi.fn(async () => snapshot);
    commands.refreshToday = vi.fn(async () => snapshot);
    commands.getRecentSnapshot = vi.fn(async () => snapshot);
    commands.queryTodayWorkspace = vi.fn(async (input) => ({
      queryId: "frozen-" + input.scope,
      entries: [
        {
          id: "file-7",
          kind: "file" as const,
          name: "调研记录.md",
          canonicalPath: "D:\\test\\调研记录.md",
          fileId: 7,
          modifiedAtUtcMs: 1,
          sizeBytes: 12,
          source: "本机",
          fileCount: 1,
          childDirectoryCount: 0,
          hasChildren: false,
          valueSummary: {
            valuable: 0,
            notValuable: 0,
            pending: 1,
            failed: 0,
            unsupported: 0,
          },
        },
      ],
      totalFileCount: 1,
      nextCursor: null,
    }));
    render(
      <MaterialBasketProvider commands={commands}>
        <TodayPage commands={commands} />
      </MaterialBasketProvider>,
    );
    const checked = await screen.findByLabelText("选择 调研记录.md");
    fireEvent.click(checked);
    fireEvent.click(screen.getByRole("button", { name: "加入资料筐" }));
    await waitFor(() =>
      expect(commands.addToBasket).toHaveBeenCalledWith({
        kind: "today",
        queryId: "frozen-today",
        fileIds: [7],
        directoryIds: [],
      }),
    );
    expect(checked).toBeChecked();
    fireEvent.click(screen.getByRole("tab", { name: "过去" }));
    await screen.findByText("过去 5 天");
    fireEvent.contextMenu(await screen.findByText("调研记录.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "加入资料筐" }));
    await waitFor(() =>
      expect(commands.addToBasket).toHaveBeenCalledWith({
        kind: "recent",
        queryId: "frozen-recent",
        fileIds: [7],
        directoryIds: [],
      }),
    );
  });
  it("知识库的真实选择令牌传递片段和去重的原件，不传文档内容", async () => {
    const commands = basket();
    commands.listRagflowDatasets = vi.fn(async () => [
      { id: "data", name: "采购库", description: "" },
    ]);
    commands.listRagflowAgents = vi.fn(async () => []);
    commands.queryRagflowKnowledge = vi.fn(async () => ({
      selectionToken: "checked-selection",
      chunks: ["one", "two"].map((id) => ({
        id,
        content: id + "-secret-body",
        documentName: "采购原件.docx",
        documentId: "doc",
        datasetId: "data",
        similarity: 1,
      })),
      agentResults: [],
    }));
    render(
      <MaterialBasketProvider commands={commands}>
        <KnowledgePage commands={commands} />
      </MaterialBasketProvider>,
    );
    await screen.findByText("采购库");
    fireEvent.click(screen.getByText("知识库（0）"));
    fireEvent.click(screen.getByLabelText("采购库"));
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "查采购文件" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    fireEvent.click(await screen.findByText("引用来源（2）"));
    for (const check of screen.getAllByLabelText("选择片段 采购原件.docx"))
      fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "所选片段加入资料筐" }));
    await waitFor(() =>
      expect(commands.addToBasket).toHaveBeenCalledWith({
        kind: "ragflowChunks",
        selectionToken: "checked-selection",
        chunks: ["one", "two"].map((chunkId) => ({
          datasetId: "data",
          documentId: "doc",
          chunkId,
        })),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "所选原文件加入资料筐" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "所选原文件加入资料筐" }),
    );
    await waitFor(() =>
      expect(commands.addToBasket).toHaveBeenCalledWith({
        kind: "ragflowDocuments",
        selectionToken: "checked-selection",
        documents: [{ datasetId: "data", documentId: "doc" }],
      }),
    );
  });
  it("材料加入当前会话但不发送或覆盖草稿；下一条实际请求带同一交接编号", async () => {
    const commands = basket(),
      project = {
        id: "p",
        name: "项目",
        goal: null,
        rootPath: "managed",
        status: "active",
        createdAtUtcMs: 1,
        updatedAtUtcMs: 1,
        lastOpenedAtUtcMs: 1,
      };
    const conv = {
      id: "c",
      projectId: "p",
      title: "采购复核",
      codexThreadId: null,
      codexSessionId: null,
      status: "draft",
      createdAtUtcMs: 1,
      updatedAtUtcMs: 1,
      archivedAtUtcMs: null,
    };
    commands.listCodexProjects = vi.fn(async () => [project]);
    commands.listCodexConversations = vi.fn(async () => [conv]);
    commands.readCodexConversation = vi.fn(async () => ({
      conversation: conv,
      turns: [],
    }));
    commands.listCodexMaterials = vi.fn(async () => []);
    commands.listCodexArtifacts = vi.fn(async () => []);
    let pending: CodexHandoffDetails[] = [];
    commands.listPendingCodexHandoffs = vi.fn(async () => pending);
    commands.attachBasketToCodex = vi.fn(
      async ({ conversationId, projectId, requestId }) => {
        pending = [
          {
            handoff: {
              id: "real-handoff",
              requestId,
              sourceKind: "basket",
              projectId,
              conversationId,
              status: "ready",
              createdAtUtcMs: 1,
              consumedAtUtcMs: null,
              errorSummary: null,
            },
            items: [
              {
                id: "h-item",
                handoffId: "real-handoff",
                materialId: "material",
                materialVersionId: "snapshot-7",
                displayName: "调研记录.md",
                displayOrder: 0,
                state: "ready",
                sourceMetadataJson: "{}",
              },
            ],
          },
        ];
        return {
          handoffId: "real-handoff",
          projectId,
          conversationId,
          itemCount: 1,
          status: "ready",
        };
      },
    );
    commands.startCodexTurn = vi.fn(async () => {
      pending = [];
      return { localTurnId: "turn", codexTurnId: "turn", threadId: "thread" };
    });
    render(
      <MaterialBasketProvider commands={commands}>
        <CodexPage commands={commands} />
      </MaterialBasketProvider>,
    );
    const composer = await screen.findByPlaceholderText(/Enter 发送/);
    fireEvent.change(composer, { target: { value: "检查这份记录" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "从资料筐添加" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择筐中资料 调研记录.md" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "添加到当前会话" }));
    await screen.findByText("已添加 1 项到当前会话，将随下一条消息发送。");
    expect(commands.attachBasketToCodex).toHaveBeenCalledWith({
      itemIds: ["basket-1"],
      projectId: "p",
      conversationId: "c",
      requestId: expect.any(String),
    });
    expect(commands.startCodexTurn).not.toHaveBeenCalled();
    expect(composer).toHaveValue("检查这份记录");
    expect(screen.getByLabelText("移除待用资料 调研记录.md")).toBeVisible();
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(commands.startCodexTurn).toHaveBeenCalledWith(
        {
          projectId: "p",
          conversationId: "c",
          prompt: "检查这份记录",
          handoffIds: ["real-handoff"],
        },
        expect.any(Function),
      ),
    );
  });
});
