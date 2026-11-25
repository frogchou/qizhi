export type SkillFile = {
  path: string;
  contentBase64: string;
  sha256?: string;
};
const encoder = new TextEncoder();
export const markdownLimit = 48 * 1024;
const attachmentLimit = 256 * 1024;

export function contentSize(encoded: string) {
  return (
    (encoded.length * 3) / 4 -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
  );
}
export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
export function fileBytes(encoded: string) {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
}
export async function verifiedBytes(file: SkillFile) {
  const data = fileBytes(file.contentBase64);
  if (file.sha256) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    const digest = Array.from(hash, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== file.sha256.toLowerCase())
      throw Error("文件与该资源版本的摘要不一致，请重新读取版本内容。");
  }
  return data;
}
function hasControls(s: string, allowWhitespace = false) {
  return Array.from(s).some((c) => {
    const n = c.charCodeAt(0);
    return (
      (n < 32 && !(allowWhitespace && (n === 9 || n === 10 || n === 13))) ||
      (n >= 127 && n <= 159)
    );
  });
}
export function filePreview(data: Uint8Array) {
  if (!data.length) return "空文件";
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (!hasControls(decoded, true)) return decoded;
  } catch {
    // Binary data is displayed as bytes below.
  }
  const prefix = Array.from(data.subarray(0, 256), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join(" ");
  return (
    "二进制内容 · 共 " +
    data.length +
    " 字节\n" +
    prefix +
    (data.length > 256 ? " …" : "")
  );
}
export function checkSkillFiles(files: { path: string; size: number }[]) {
  if (files.length > 16) throw Error("一个 Skill 最多可包含 16 个辅助文件。");
  if (files.reduce((n, f) => n + f.size, 0) > attachmentLimit)
    throw Error("辅助文件原始大小合计最多 256 KiB。");
  const paths = new Set(["skill.md"]);
  const directories = new Map<string, string>();
  for (const { path } of files) {
    const parts = path.split("/");
    const invalid =
      path.length > 512 ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /[<>:"\\|?*]/.test(part) ||
          hasControls(part) ||
          encoder.encode(part).length > 255 ||
          /^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(
            part,
          ),
      );
    if (invalid) throw Error("请选择有效的相对文件路径。当前路径为 " + path);
    const key = path.normalize("NFC").toLowerCase();
    if (paths.has(key) || directories.has(key))
      throw Error("文件路径重复或与 Skill 正文重名。当前路径为 " + path);
    paths.add(key);
    while (parts.length > 1) {
      parts.pop();
      const directory = parts.join("/");
      const canonical = directory.normalize("NFC").toLowerCase();
      if (
        paths.has(canonical) ||
        (directories.has(canonical) && directories.get(canonical) !== directory)
      )
        throw Error("文件与目录的路径冲突。当前路径为 " + path);
      directories.set(canonical, directory);
    }
  }
}
export async function readMarkdown(file: File) {
  if (file.size > markdownLimit)
    throw Error("中台接受最多 48 KiB 的 Skill 正文。");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw Error("Skill 正文需要使用 UTF-8 文本。");
  }
}
export async function importSkillFiles(
  existing: SkillFile[],
  selection: File[],
  directory: boolean,
) {
  let main: File | undefined;
  const additions: { path: string; file: File }[] = [];
  for (const file of selection) {
    const path = directory
      ? file.webkitRelativePath.split("/").slice(1).join("/")
      : file.name;
    if (directory && path.toLowerCase() === "skill.md") {
      if (main) throw Error("所选文件夹包含多个同名的 Skill 正文。");
      main = file;
    } else {
      additions.push({ path, file });
    }
  }
  checkSkillFiles([
    ...existing.map((f) => ({
      path: f.path,
      size: contentSize(f.contentBase64),
    })),
    ...additions.map(({ path, file }) => ({ path, size: file.size })),
  ]);
  const markdown = main ? await readMarkdown(main) : undefined;
  const attachments = await Promise.all(
    additions.map(async ({ path, file }) => ({
      path,
      contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
    })),
  );
  return { files: [...existing, ...attachments], markdown };
}
