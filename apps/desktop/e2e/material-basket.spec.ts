import { expect, test } from "@playwright/test";

test("切换页面保留资料筐；选择本地文件、去重、清空和关闭均不改变当前页面", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const record = {
      id: "basket-a",
      kind: "local",
      displayName: "文档快照.md",
      sourceLabel: "本机文件",
      sizeBytes: 87,
      sha256: "x",
      addedAtUtcMs: 1,
    };
    let saved = false;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          if (command === "factory_get_settings")
            return { mode: "demo", endpoint: "", hasToken: false };
          if (command === "basket_list") return saved ? [record] : [];
          if (command === "basket_pick_local") {
            const status = saved ? "existing" : "added";
            saved = true;
            return [
              {
                key: "test-file",
                displayName: record.displayName,
                status,
                item: record,
                error: null,
              },
            ];
          }
          if (command === "basket_clear" || command === "basket_remove") {
            saved = false;
            return;
          }
          if (
            [
              "list_ragflow_datasets",
              "list_ragflow_agents",
              "get_settings",
            ].includes(command)
          )
            return [];
          throw new Error("测试未连接此桌面服务");
        },
      },
    });
  });
  const onPageErrors: string[] = [];
  page.on("pageerror", (e) => onPageErrors.push(e.message));
  await page.goto("/");
  const open = page.getByRole("button", { name: "资料筐", exact: true }),
    dialog = page.getByRole("dialog", { name: "资料筐" });
  await open.click();
  await expect(dialog.getByText(/资料筐为空/)).toBeVisible();
  await dialog.getByRole("button", { name: "添加本地文件" }).click();
  await expect(dialog.getByText("文档快照.md", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "添加本地文件" }).click();
  await expect(dialog.getByRole("status")).toContainText("筐中已有 1 项");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await open.click();
  await expect(dialog.getByText("文档快照.md", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "清空资料筐" }).click();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog.getByText("文档快照.md", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "清空资料筐" }).click();
  await dialog.getByRole("button", { name: "确认清空" }).click();
  await expect(dialog.getByText(/资料筐为空/)).toBeVisible();
  await dialog.getByRole("button", { name: "关闭资料筐" }).click();
  await expect(page.getByRole("heading", { name: "知识库问答" })).toBeVisible();
  expect(onPageErrors).toEqual([]);
});
test("普通浏览器明确说明资料筐依赖桌面服务，移动端也能打开和关闭", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 820 });
  await page.goto("/");
  await page.getByRole("button", { name: "资料筐", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "资料筐" });
  await expect(dialog).toContainText("本机资料筐需要栖知桌面端。");
  await expect(
    dialog.getByRole("button", { name: "添加本地文件" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
for (const [width, height] of [
  [1280, 760],
  [1024, 420],
  [412, 680],
]) {
  test(`侧栏底部工具可达且与业务导航分开 ${width} × ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "主导航" }),
      tool = page.getByRole("button", { name: "资料筐", exact: true });
    await expect(
      nav.getByRole("button", { name: "智能工厂", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "资料筐" })).toHaveCount(0);
    await expect(tool).toBeInViewport();
    const toolBox = await tool.boundingBox();
    expect(toolBox!.y + toolBox!.height).toBeLessThanOrEqual(height);
    const navBox = await nav.boundingBox();
    expect(toolBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height - 1);
    await tool.click();
    const dialog = page.getByRole("dialog", { name: "资料筐" });
    await expect(
      dialog.getByRole("button", { name: "关闭资料筐" }),
    ).toBeInViewport();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    expect(box!.height).toBeLessThanOrEqual(height);
  });
}
