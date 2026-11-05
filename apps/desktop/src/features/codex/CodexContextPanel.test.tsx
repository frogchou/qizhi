import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodexContextPanel } from "./CodexContextPanel";

const material = {
  id: "material-1",
  projectId: "project-1",
  kind: "local",
  displayName: "经营计划.docx",
  originReference: "D:\\资料\\经营计划.docx",
  sourceMetadataJson: null,
  currentVersionId: "version-1",
  snapshotState: "ready",
  importedAtUtcMs: 1,
};

describe("CodexContextPanel", () => {
  it("shows source state and exposes refresh, reveal and remove actions", () => {
    const onRefreshMaterial = vi.fn();
    const onRevealMaterialSource = vi.fn();
    const onRemoveMaterial = vi.fn();
    render(
      <CodexContextPanel
        materials={[material]}
        materialStatuses={[
          {
            materialId: material.id,
            state: "source_changed",
            sourceLabel: material.originReference,
            refreshable: true,
            revealable: true,
          },
        ]}
        artifacts={[]}
        importing={false}
        onImport={vi.fn()}
        onRefreshMaterial={onRefreshMaterial}
        onRevealMaterialSource={onRevealMaterialSource}
        onRemoveMaterial={onRemoveMaterial}
        onOpenArtifact={vi.fn()}
        onRevealArtifact={vi.fn()}
        onExportArtifact={vi.fn()}
        onUploadArtifact={vi.fn()}
      />,
    );

    expect(screen.getByText("来源已有更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看来源" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(onRevealMaterialSource).toHaveBeenCalledWith(material.id);
    expect(onRefreshMaterial).toHaveBeenCalledWith(material.id);
    expect(onRemoveMaterial).toHaveBeenCalledWith(material.id);
  });

  it("locks project mutations while a task is active", () => {
    render(
      <CodexContextPanel
        materials={[material]}
        materialStatuses={[
          {
            materialId: material.id,
            state: "ready",
            sourceLabel: material.originReference,
            refreshable: true,
            revealable: true,
          },
        ]}
        artifacts={[]}
        importing={false}
        locked
        onImport={vi.fn()}
        onRefreshMaterial={vi.fn()}
        onRevealMaterialSource={vi.fn()}
        onRemoveMaterial={vi.fn()}
        onOpenArtifact={vi.fn()}
        onRevealArtifact={vi.fn()}
        onExportArtifact={vi.fn()}
        onUploadArtifact={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "＋ 添加" })).toBeDisabled();
  });
});
