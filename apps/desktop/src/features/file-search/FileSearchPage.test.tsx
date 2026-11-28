import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { unavailableCommands, type FileSearchPageData } from "../../lib/tauri";
import { render } from "../../test/render";
import { FileSearchPage } from "./FileSearchPage";

function page(
  name: string,
  nextCursor: string | null = null,
): FileSearchPageData {
  return {
    files: [
      {
        recordKey: name,
        name,
        path: `/Users/test/${name}`,
        sizeBytes: 25,
        modifiedAtUtcMs: 1,
      },
    ],
    nextCursor,
    coverage: [{ path: "/Users/test", state: "ready" }],
  };
}

describe("FileSearchPage", () => {
  it("keeps only the latest query even when an earlier request resolves later", async () => {
    let returnOld: (result: FileSearchPageData) => void = () => undefined;
    const searchLocalFiles = vi.fn(({ query }: { query: string }) => {
      if (query === "合同")
        return new Promise<FileSearchPageData>((resolve) => {
          returnOld = resolve;
        });
      return Promise.resolve(
        query === "预算" ? page("预算.md") : { ...page(""), files: [] },
      );
    });
    render(
      <FileSearchPage
        commands={{ ...unavailableCommands, searchLocalFiles }}
      />,
    );
    const input = await screen.findByRole("searchbox", {
      name: "查找文件名或路径",
    });
    fireEvent.change(input, { target: { value: "合同" } });
    await waitFor(() =>
      expect(searchLocalFiles).toHaveBeenCalledWith({
        query: "合同",
        cursor: null,
      }),
    );
    fireEvent.change(input, { target: { value: "预算" } });
    expect(await screen.findByText("预算.md")).toBeVisible();
    returnOld(page("合同.md"));
    await waitFor(() =>
      expect(screen.queryByText("合同.md")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("预算.md")).toBeVisible();
  });

  it("appends the next page and uses the distinct opaque key for file actions", async () => {
    const searchLocalFiles = vi.fn(
      ({ query, cursor }: { query: string; cursor: string | null }) =>
        Promise.resolve(
          !query
            ? { ...page(""), files: [] }
            : cursor
              ? page("另一份合同.md")
              : page("公司合同.md", "next"),
        ),
    );
    const actOnSearchResult = vi.fn().mockResolvedValue(undefined);
    render(
      <FileSearchPage
        commands={{
          ...unavailableCommands,
          searchLocalFiles,
          actOnSearchResult,
        }}
      />,
    );
    const input = await screen.findByRole("searchbox", {
      name: "查找文件名或路径",
    });
    fireEvent.change(input, { target: { value: "合同" } });
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("另一份合同.md")).toBeVisible();
    expect(screen.getByText("公司合同.md")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "在 Finder 定位 另一份合同.md" }),
    );
    await waitFor(() =>
      expect(actOnSearchResult).toHaveBeenCalledWith("另一份合同.md", "reveal"),
    );
  });

  it("refreshes a changed second page without collapsing the loaded results", async () => {
    let second = page("旧合同.md");
    const searchLocalFiles = vi.fn(
      ({ query, cursor }: { query: string; cursor: string | null }) =>
        Promise.resolve(
          !query
            ? { ...page(""), files: [] }
            : cursor
              ? second
              : page("第一份合同.md", "next"),
        ),
    );
    render(
      <FileSearchPage
        commands={{ ...unavailableCommands, searchLocalFiles }}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "合同" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("旧合同.md")).toBeVisible();
    second = page("新合同.md");
    expect(
      await screen.findByText("新合同.md", undefined, { timeout: 3500 }),
    ).toBeVisible();
    expect(screen.getByText("第一份合同.md")).toBeVisible();
    expect(screen.queryByText("旧合同.md")).not.toBeInTheDocument();
  });

  it("keeps a successful page append when an older refresh fails, including partial coverage", async () => {
    let refreshStarted = false;
    let rejectRefresh: (reason: Error) => void = () => undefined;
    let requestedFirst = false;
    const first = page("已显示合同.md", "next");
    first.coverage[0].state = "partial";
    const searchLocalFiles = vi.fn(
      ({ query, cursor }: { query: string; cursor: string | null }) => {
        if (!query) return Promise.resolve({ ...page(""), files: [] });
        if (cursor) return Promise.resolve(page("下一页合同.md"));
        if (!requestedFirst) {
          requestedFirst = true;
          return Promise.resolve(first);
        }
        refreshStarted = true;
        return new Promise<FileSearchPageData>((_resolve, reject) => {
          rejectRefresh = reject;
        });
      },
    );
    render(
      <FileSearchPage
        commands={{ ...unavailableCommands, searchLocalFiles }}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "合同" },
    });
    expect(await screen.findByText("已显示合同.md")).toBeVisible();
    await waitFor(() => expect(refreshStarted).toBe(true), { timeout: 3500 });
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("下一页合同.md")).toBeVisible();
    await act(async () => rejectRefresh(new Error("旧轮询请求失败")));
    expect(screen.getByText("下一页合同.md")).toBeVisible();
    expect(screen.getByText("0 / 1 个工作目录已就绪")).toBeVisible();
    expect(screen.queryByText("旧轮询请求失败")).not.toBeInTheDocument();
  });
});
