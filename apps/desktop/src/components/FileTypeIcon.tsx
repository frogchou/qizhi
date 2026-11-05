export type FileVisualType =
  | "pdf"
  | "word"
  | "sheet"
  | "slides"
  | "markdown"
  | "text"
  | "code"
  | "data"
  | "generic";

const FILE_TYPES: Record<Exclude<FileVisualType, "generic">, Set<string>> = {
  pdf: new Set(["pdf"]),
  word: new Set(["doc", "docx", "odt", "rtf"]),
  sheet: new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv"]),
  slides: new Set(["ppt", "pptx", "odp"]),
  markdown: new Set(["md", "mdx", "markdown"]),
  text: new Set(["txt", "log"]),
  code: new Set([
    "c",
    "cc",
    "cpp",
    "cs",
    "css",
    "dart",
    "go",
    "h",
    "hpp",
    "html",
    "java",
    "js",
    "jsx",
    "kt",
    "kts",
    "less",
    "lua",
    "php",
    "ps1",
    "py",
    "r",
    "rb",
    "rs",
    "sass",
    "scss",
    "sh",
    "sql",
    "svelte",
    "swift",
    "ts",
    "tsx",
    "vue",
  ]),
  data: new Set(["ini", "json", "toml", "xml", "yaml", "yml"]),
};

const VISUALS: Record<FileVisualType, { label: string; marker: string }> = {
  pdf: { label: "PDF 文件", marker: "PDF" },
  word: { label: "Word 文档", marker: "W" },
  sheet: { label: "电子表格", marker: "X" },
  slides: { label: "演示文稿", marker: "P" },
  markdown: { label: "Markdown 文档", marker: "MD" },
  text: { label: "文本文件", marker: "TXT" },
  code: { label: "代码文件", marker: "</>" },
  data: { label: "数据文件", marker: "{}" },
  generic: { label: "文件", marker: "" },
};

function fileExtension(path: string) {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLowerCase()
    : "";
}

export function fileVisualType(path: string): FileVisualType {
  const extension = fileExtension(path);
  for (const [kind, extensions] of Object.entries(FILE_TYPES)) {
    if (extensions.has(extension)) return kind as FileVisualType;
  }
  return "generic";
}

export function FileTypeIcon({ path }: { path: string }) {
  const kind = fileVisualType(path);
  const visual = VISUALS[kind];

  return (
    <span className={`file-type-icon file-type-${kind}`} title={visual.label}>
      <svg
        viewBox="0 0 22 24"
        data-file-kind={kind}
        role="img"
        aria-label={visual.label}
      >
        <path className="file-type-page" d="M3.5 1.5h9l6 6v15h-15Z" />
        <path className="file-type-fold" d="M12.5 1.5v6h6" />
        {visual.marker ? (
          <text className="file-type-marker" x="11" y="17.2">
            {visual.marker}
          </text>
        ) : (
          <path className="file-type-lines" d="M7 13h8M7 16h6" />
        )}
      </svg>
    </span>
  );
}
