import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileTypeIcon, fileVisualType } from "./FileTypeIcon";

describe("fileVisualType", () => {
  it.each([
    ["C:\\docs\\report.PDF", "pdf"],
    ["proposal.docx", "word"],
    ["budget.XLSX", "sheet"],
    ["roadmap.pptx", "slides"],
    ["README.MD", "markdown"],
    ["notes.txt", "text"],
    ["component.TSX", "code"],
    ["settings.json", "data"],
    ["archive.unknown", "generic"],
    ["LICENSE", "generic"],
  ])("maps %s to %s", (path, expected) => {
    expect(fileVisualType(path)).toBe(expected);
  });
});

describe("FileTypeIcon", () => {
  it.each([
    ["report.pdf", "pdf", "PDF 文件"],
    ["proposal.docx", "word", "Word 文档"],
    ["README.md", "markdown", "Markdown 文档"],
    ["component.tsx", "code", "代码文件"],
  ])("renders a readable %s icon", (path, kind, title) => {
    const { container } = render(<FileTypeIcon path={path} />);

    expect(
      container.querySelector(`[data-file-kind="${kind}"]`),
    ).toBeInTheDocument();
    expect(screen.getByTitle(title)).toBeInTheDocument();
  });
});
