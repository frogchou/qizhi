import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, it, vi, expect } from "vitest";
import App from "../../App";
import { unavailableCommands, type QizhiCommands } from "../../lib/tauri";
import {
  MaterialBasketProvider,
  MaterialBasketSelector,
} from "./MaterialBasket";
import { type BasketItem, type BasketResult } from "./basket-types";

const one: BasketItem = {
  id: "item-a",
  kind: "local",
  displayName: "当地报告.docx",
  sourceLabel: "本地",
  sizeBytes: 512,
  sha256: "a",
  addedAtUtcMs: 12,
};
const two: BasketItem = {
  ...one,
  id: "item-b",
  kind: "ragflowChunk",
  displayName: "项目进度片段",
  sourceLabel: "档案库",
  sha256: "b",
};
function selection(initial: string[]) {
  return function Selected() {
    const [ids, setIds] = useState(initial);
    return (
      <>
        <MaterialBasketSelector selectedIds={ids} onChange={setIds} />
        <output>{ids.join(",")}</output>
      </>
    );
  };
}
describe("共享资料筐", () => {
  it("全局按钮跨页可用，本地选择去重、局部错误可见，移除和清空有真实调用", async () => {
    let records = [one];
    const results: BasketResult[] = [
      {
        key: one.id,
        displayName: one.displayName,
        status: "existing",
        item: one,
        error: null,
      },
      {
        key: two.id,
        displayName: two.displayName,
        status: "added",
        item: two,
        error: null,
      },
      {
        key: "failed",
        displayName: "缺失文件",
        status: "failed",
        item: null,
        error: "源已移动",
      },
    ];
    const client: QizhiCommands = {
      ...unavailableCommands,
      listBasket: vi.fn(async () => [...records]),
      pickBasketLocal: vi.fn(async () => {
        records = [one, two];
        return results;
      }),
      removeFromBasket: vi.fn(async (ids) => {
        records = records.filter((i) => !ids.includes(i.id));
      }),
      clearBasket: vi.fn(async () => {
        records = [];
      }),
    };
    render(<App commands={client} />);
    fireEvent.click(screen.getByRole("button", { name: "资料筐" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "资料筐" }),
    );
    expect(await dialog.findByText(one.displayName)).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "添加本地文件" }));
    await dialog.findByText(/缺失文件.*源已移动/);
    expect(dialog.getByText(/筐中已有 1 项/)).toBeVisible();
    fireEvent.click(dialog.getByLabelText("选择 当地报告.docx"));
    fireEvent.click(dialog.getByRole("button", { name: "移除所选（1）" }));
    await waitFor(() =>
      expect(client.removeFromBasket).toHaveBeenCalledWith([one.id]),
    );
    await waitFor(() => expect(dialog.queryByText(one.displayName)).toBeNull());
    fireEvent.click(dialog.getByRole("button", { name: "关闭资料筐" }));
    fireEvent.click(screen.getByRole("button", { name: "知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "资料筐" }));
    const reopened = within(
      await screen.findByRole("dialog", { name: "资料筐" }),
    );
    expect(await reopened.findByText(two.displayName)).toBeVisible();
    fireEvent.click(reopened.getByRole("button", { name: "清空资料筐" }));
    fireEvent.click(reopened.getByRole("button", { name: "取消" }));
    expect(client.clearBasket).not.toHaveBeenCalled();
    fireEvent.click(reopened.getByRole("button", { name: "清空资料筐" }));
    fireEvent.click(reopened.getByRole("button", { name: "确认清空" }));
    await reopened.findByText(/资料筐为空/);
    expect(client.clearBasket).toHaveBeenCalledTimes(1);
  });
  it("多选全选保留唯一 ID，筐中已移除的选择可见并可取消", async () => {
    const commands = {
      ...unavailableCommands,
      listBasket: vi.fn(async () => [one, two]),
    };
    const Selected = selection([one.id, "gone"]);
    render(
      <MaterialBasketProvider commands={commands}>
        <Selected />
      </MaterialBasketProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "从资料筐选择" }));
    await screen.findByText(/已从资料筐移除.*gone/);
    fireEvent.click(screen.getByRole("checkbox", { name: "全选筐中资料" }));
    expect(screen.getByText("item-a,gone,item-b")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除已选资料 gone" }));
    expect(screen.getByText("item-a,item-b")).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "已选资料筐材料" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);
  });
  it("紧凑工具栏保留上传和选筐的顺序，部分选中与重复来源可区分", async () => {
    const record = {
      ...one,
      kind: "today" as const,
      sourceLabel: "今日文件 · 今日文件",
    };
    const commands = {
      ...unavailableCommands,
      listBasket: vi.fn(async () => [record, two]),
    };
    function Toolbar() {
      const [ids, setIds] = useState<string[]>([]);
      return (
        <MaterialBasketSelector
          compact
          leadingAction={<button type="button">上传本地附件</button>}
          selectedIds={ids}
          onChange={setIds}
        />
      );
    }
    render(
      <MaterialBasketProvider commands={commands}>
        <Toolbar />
      </MaterialBasketProvider>,
    );
    const selector = within(
      screen.getByRole("region", { name: "从资料筐选择材料" }),
    );
    expect(selector.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "上传本地附件",
      "从资料筐选择",
    ]);
    fireEvent.click(selector.getByRole("button", { name: "从资料筐选择" }));
    expect(
      await selector.findByText("今日文件", { exact: true }),
    ).toBeVisible();
    expect(selector.queryByText("今日文件 · 今日文件")).toBeNull();
    fireEvent.click(selector.getByLabelText("选择筐中资料 " + one.displayName));
    expect(selector.getByLabelText("全选筐中资料")).toBePartiallyChecked();
  });
  it("普通浏览器明确显示本机服务不可用", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "资料筐" }));
    expect(await screen.findByText("本机资料筐需要栖知桌面端。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "添加本地文件" })).toBeNull();
  });
});
