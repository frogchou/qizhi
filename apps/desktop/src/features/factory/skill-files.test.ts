import { describe, expect, it } from "vitest";
import {
  checkSkillFiles,
  contentSize,
  fileBytes,
  filePreview,
  toBase64,
} from "./skill-files";

describe("Skill 随包文件", () => {
  it("按原始字节计算数量、空文件、256 KiB 上限并支持往返二进制", () => {
    const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256);
    const encoded = toBase64(bytes);
    expect(contentSize(encoded)).toBe(bytes.length);
    expect(fileBytes(encoded)).toEqual(bytes);
    expect(contentSize("")).toBe(0);
    expect(contentSize("AA==")).toBe(1);
    expect(contentSize("AAA=")).toBe(2);
    expect(() =>
      checkSkillFiles([{ path: "examples/table.bin", size: bytes.length }]),
    ).not.toThrow();
    expect(() =>
      checkSkillFiles([
        { path: "a", size: bytes.length },
        { path: "b", size: 1 },
      ]),
    ).toThrow(/256 KiB/);
    expect(() =>
      checkSkillFiles(
        Array.from({ length: 17 }, (_, i) => ({ path: "file" + i, size: 0 })),
      ),
    ).toThrow(/16/);
    expect(filePreview(fileBytes("AAH+"))).toContain("00 01 fe");
    expect(filePreview(new TextEncoder().encode("采购\n价格"))).toBe(
      "采购\n价格",
    );
  });
  it("拒绝歧义路径、Windows 保留名及与主文件、现有文件冲突的路径", () => {
    const bad = [
      "SKILL.md",
      "Skill.md/x",
      "../a",
      "/a",
      "a//b",
      "a/./b",
      "a/b.",
      "b/CON.txt",
      "a\\b",
      "table?.csv",
      "part:2",
      "x ".repeat(260),
      "报".repeat(86),
    ];
    for (const path of bad)
      expect(() => checkSkillFiles([{ path, size: 0 }])).toThrow();
    for (const pair of [
      ["é.txt", "e\u0301.txt"],
      ["Rules/A", "rules/a"],
      ["Rules/A.csv", "rules/B.csv"],
      ["rules", "RULES/a.csv"],
      ["x/y", "X"],
    ]) {
      expect(() =>
        checkSkillFiles(pair.map((path) => ({ path, size: 0 }))),
      ).toThrow();
    }
    expect(() =>
      checkSkillFiles([
        { path: "表格/币种.csv", size: 1 },
        { path: "表格/产品.csv", size: 9 },
      ]),
    ).not.toThrow();
  });
});
