import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "../App";
import { unavailableCommands, type QizhiCommands } from "../lib/tauri";

describe("App", () => {
  it("renders the Qizhi product name", () => {
    render(<App />);

    expect(screen.getByText("栖知")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent("今日");
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent("知识库");
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent(
      "Codex 工作",
    );
    expect(screen.getAllByRole("navigation")[0]).toHaveTextContent("设置");
  });

  it("uses a fixed workspace shell for the knowledge conversation", () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "知识库" }));

    expect(
      container.querySelector(".workspace.knowledge-workspace-shell"),
    ).toBeInTheDocument();
  });

  it("keeps the knowledge conversation and selected resources while navigating inside the app", async () => {
    const commands: QizhiCommands = {
      ...unavailableCommands,
      listRagflowDatasets: vi
        .fn()
        .mockResolvedValue([
          { id: "dataset-1", name: "公司知识库", description: "公司资料" },
        ]),
      listRagflowAgents: vi
        .fn()
        .mockResolvedValue([
          { id: "agent-1", name: "公司助手", description: "资料问答" },
        ]),
      queryRagflowKnowledge: vi.fn().mockResolvedValue({
        chunks: [],
        retrievalError: null,
        agentResults: [
          {
            agentId: "agent-1",
            answer: "这是本次应用会话中的回答。",
            error: null,
          },
        ],
      }),
    };
    const { container } = render(<App commands={commands} />);

    fireEvent.click(screen.getByRole("button", { name: "知识库" }));
    await screen.findByText("公司知识库");
    fireEvent.click(screen.getByText("知识库（0）"));
    fireEvent.click(screen.getByLabelText("公司知识库"));
    fireEvent.click(screen.getByText("Agents（0）"));
    fireEvent.click(screen.getByLabelText("公司助手"));
    fireEvent.change(screen.getByLabelText("询问你的工作知识库"), {
      target: { value: "今年多大岁数？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    expect(
      await screen.findByText("这是本次应用会话中的回答。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    expect(container.querySelector(".knowledge-page")).toHaveAttribute(
      "style",
      "display: none;",
    );
    fireEvent.click(screen.getByRole("button", { name: "知识库" }));

    await waitFor(() => {
      expect(screen.getByLabelText("公司知识库")).toBeChecked();
      expect(screen.getByLabelText("公司助手")).toBeChecked();
    });
    expect(screen.getAllByText("今年多大岁数？")).toHaveLength(2);
    expect(screen.getByText("这是本次应用会话中的回答。")).toBeInTheDocument();
  });
});
