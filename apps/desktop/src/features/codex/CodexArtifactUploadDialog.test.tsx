import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { unavailableCommands, type QizhiCommands } from "../../lib/tauri";
import { CodexArtifactUploadDialog } from "./CodexArtifactUploadDialog";

const artifact = {
  id: "artifact-1",
  projectId: "project-1",
  relativePath: "reports/result.md",
  contentHash: "hash",
  sizeBytes: 128,
  mimeType: "text/markdown",
  createdByConversationId: "conversation-1",
  createdByTurnId: "turn-1",
  detectedAtUtcMs: 1,
  state: "active",
};

describe("CodexArtifactUploadDialog", () => {
  it("requires a dataset and uploads with parsing options", async () => {
    const commands: QizhiCommands = {
      ...unavailableCommands,
      listRagflowDatasets: vi
        .fn()
        .mockResolvedValue([
          { id: "dataset-1", name: "项目资料", description: "" },
        ]),
      listCodexArtifactUploads: vi.fn().mockResolvedValue([]),
      uploadCodexArtifact: vi.fn().mockResolvedValue({
        id: "upload-1",
        artifactId: artifact.id,
        datasetId: "dataset-1",
        parentPath: "reports",
        contentHash: artifact.contentHash,
        documentIdsJson: '["doc-1"]',
        status: "uploaded",
        startParsing: true,
        createdAtUtcMs: 2,
        completedAtUtcMs: 3,
        errorSummary: null,
      }),
    };
    render(
      <CodexArtifactUploadDialog
        artifact={artifact}
        commands={commands}
        onClose={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("目标知识库"), {
      target: { value: "dataset-1" },
    });
    fireEvent.change(screen.getByLabelText("知识库内目录"), {
      target: { value: "reports" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
    await waitFor(() =>
      expect(commands.uploadCodexArtifact).toHaveBeenCalledWith({
        artifactId: artifact.id,
        datasetId: "dataset-1",
        parentPath: "reports",
        startParsing: true,
        confirmDuplicate: false,
      }),
    );
  });

  it("asks before a confirmed duplicate retry", async () => {
    const commands: QizhiCommands = {
      ...unavailableCommands,
      listRagflowDatasets: vi
        .fn()
        .mockResolvedValue([
          { id: "dataset-1", name: "项目资料", description: "" },
        ]),
      listCodexArtifactUploads: vi.fn().mockResolvedValue([]),
      uploadCodexArtifact: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("该生成物已上传到此知识库，请确认是否再次上传。"),
        )
        .mockResolvedValueOnce({ status: "uploaded" }),
    };
    render(
      <CodexArtifactUploadDialog
        artifact={artifact}
        commands={commands}
        onClose={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("目标知识库"), {
      target: { value: "dataset-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "上传并解析" }));
    expect(await screen.findByText(/已上传到此知识库/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认再次上传" }));
    await waitFor(() =>
      expect(commands.uploadCodexArtifact).toHaveBeenLastCalledWith(
        expect.objectContaining({ confirmDuplicate: true }),
      ),
    );
  });
});
