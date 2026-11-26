import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { ReadNotice } from "../features/factory/FactoryControls";
import { factoryApi } from "../features/factory/factory-client";
import { useFactoryRead } from "../features/factory/factory-feed";
import { FeedbackNotice, FeedbackScope, useFeedback } from "./FeedbackNotice";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function receiptRegion() {
  return within(screen.getByRole("region", { name: "桌面提示" }));
}

it("同一操作可反复得到回执，键盘阅读时保留气泡并把焦点还给原控件", () => {
  vi.useFakeTimers();
  function Save() {
    const notify = useFeedback("success");
    return <button onClick={() => notify("已保存")}>保存</button>;
  }
  render(<Save />);
  const save = screen.getByRole("button", { name: "保存" });
  save.focus();
  fireEvent.click(save);
  expect(receiptRegion().getByRole("status")).toHaveTextContent("已保存");
  expect(save).toHaveFocus();
  const close = receiptRegion().getByRole("button", { name: "关闭提示" });
  act(() => close.focus());
  act(() => vi.advanceTimersByTime(20_000));
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(save).toHaveFocus();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(save);
  expect(receiptRegion().getByRole("status")).toHaveTextContent("已保存");
  act(() => vi.advanceTimersByTime(4500));
  expect(screen.queryByRole("status")).toBeNull();
});

it("隐藏页面的后台结果不弹出，回来后也不会重放", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function Save() {
    const notify = useFeedback();
    return (
      <button
        onClick={async () => {
          await pending;
          notify("后台保存结束");
        }}
      >
        保存
      </button>
    );
  }
  const view = (active: boolean) => (
    <FeedbackScope active={active}>
      <Save />
      <FeedbackNotice message="正在处理" />
    </FeedbackScope>
  );
  const { rerender } = render(view(true));
  expect(receiptRegion().getByRole("status")).toHaveTextContent("正在处理");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  rerender(view(false));
  await act(async () => {
    finish();
    await pending;
  });
  expect(screen.queryByRole("region", { name: "桌面提示" })).toBeNull();
  rerender(view(true));
  expect(screen.queryByRole("region", { name: "桌面提示" })).toBeNull();
});

it("首次进入设置分类时仍能看到持续的加载错误，反复切换不会重复提醒", () => {
  const settings = (active: boolean) => (
    <FeedbackScope active={active}>
      <section hidden={!active}>
        <FeedbackNotice message="无法读取模型服务商配置。" tone="error" />
      </section>
    </FeedbackScope>
  );
  const { rerender } = render(settings(false));
  expect(screen.queryByRole("alert")).toBeNull();
  rerender(settings(true));
  expect(receiptRegion().getByRole("alert")).toHaveTextContent(
    "无法读取模型服务商配置。",
  );
  fireEvent.click(receiptRegion().getByRole("button", { name: "关闭提示" }));
  rerender(settings(false));
  rerender(settings(true));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("持续读取失败只提醒一次，关闭后仍可主动重试并收到新结果", async () => {
  const get = vi
    .spyOn(factoryApi, "get")
    .mockRejectedValue(Error("工厂读取失败"));
  function Reader({ revision }: { revision: number }) {
    const read = useFactoryRead<object>("/v1/factory/overview", revision);
    return (
      <>
        <ReadNotice read={read} />
        {read.data && <p>已更新</p>}
      </>
    );
  }
  const { rerender } = render(<Reader revision={0} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("工厂读取失败");
  fireEvent.click(receiptRegion().getByRole("button", { name: "关闭提示" }));
  rerender(<Reader revision={1} />);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  const retry = screen.getByRole("button", { name: "重新读取" });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByRole("alert")).toHaveTextContent("工厂读取失败");
  get.mockResolvedValueOnce({});
  fireEvent.click(retry);
  expect(await screen.findByText("已更新")).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
});
