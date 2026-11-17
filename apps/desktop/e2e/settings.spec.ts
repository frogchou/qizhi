import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let callbackId = 1;
    const callbacks = new Map<number, (data: unknown) => void>();
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string) => unknown;
          transformCallback: (
            callback?: (data: unknown) => void,
            once?: boolean,
          ) => number;
          unregisterCallback: (id: number) => void;
          runCallback: (id: number, data: unknown) => void;
        };
      }
    ).__TAURI_INTERNALS__ = {
      transformCallback: (callback, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (data) => {
          callback?.(data);
          if (once) callbacks.delete(id);
        });
        return id;
      },
      unregisterCallback: (id) => callbacks.delete(id),
      runCallback: (id, data) => callbacks.get(id)?.(data),
      invoke: (command) => {
        if (command === "factory_get_settings")
          return Promise.resolve({
            mode: "demo",
            endpoint: "http://127.0.0.1:3010",
            hasToken: true,
          });
        if (command === "basket_list") return Promise.resolve([]);
        if (command === "get_settings") return Promise.resolve([]);
        if (command === "list_scan_rules")
          return Promise.resolve({
            allowedRoots: ["C:\\Users\\fcc\\Documents", "D:\\"],
            customExclusions: ["D:\\Cache"],
            lockedExclusions: [],
            fileCategories: ["documents", "sourceCode"],
            directoryGroupThreshold: 5,
          });
        if (command === "get_ntfs_indexer_status")
          return Promise.resolve({
            available: true,
            message: "本地 NTFS 索引服务已连接。",
          });
        if (command === "get_jev_value_policy")
          return Promise.resolve({
            instructions: "评估文件的长期知识价值。",
            criteria: ["无价值", "一般", "有价值"],
            valuableThreshold: 1.5,
          });
        if (command === "get_summary_settings")
          return Promise.resolve({
            model: "gpt-5.6-sol",
            templates: [
              {
                id: 1,
                title: "今日工作总结",
                prompt: "总结成果。",
                sortOrder: 0,
                isDefault: true,
              },
            ],
          });
        if (command === "get_codex_status")
          return Promise.resolve({
            installation: "ready",
            account: "ready",
            sandbox: "ready",
            version: "0.144.5",
          });
        if (command === "get_codex_preferences")
          return Promise.resolve({ model: "", reasoningEffort: "medium" });
        if (command === "list_codex_models") return Promise.resolve([]);
        return Promise.resolve(null);
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置" }).click();
});

test("uses a fixed category rail and switches one settings panel at a time", async ({
  page,
}) => {
  const navigation = page.getByRole("navigation", { name: "设置分类" });
  const content = page.locator(".settings-category-content");
  await expect(navigation).toBeVisible();
  await expect(page.locator("#settings-panel-privacy")).toBeVisible();
  await expect(page.locator("#settings-panel-services")).toBeHidden();

  const navigationBox = await navigation.boundingBox();
  const contentBox = await content.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(navigationBox!.x + navigationBox!.width).toBeLessThan(contentBox!.x);

  await page.getByRole("button", { name: "连接服务" }).click();
  await expect(page.locator("#settings-panel-services")).toBeVisible();
  await expect(page.locator("#settings-panel-privacy")).toBeHidden();
});

test("moves categories above content without horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const navigation = page.getByRole("navigation", { name: "设置分类" });
  const content = page.locator(".settings-category-content");
  const navigationBox = await navigation.boundingBox();
  const contentBox = await content.boundingBox();

  expect(navigationBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(
    contentBox!.y,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1024);

  await navigation.getByRole("button", { name: "Codex 工作" }).click();
  await expect(page.locator("#settings-panel-codex")).toBeVisible();
});

test("工厂运行模式可用键盘切换，连接字段在窄窗口中完整显示", async ({
  page,
}) => {
  const rail = page.getByRole("navigation", { name: "设置分类" });
  await rail.getByRole("button", { name: "智能工厂", exact: true }).click();
  const card = page.locator("#settings-panel-factory"),
    group = card.getByRole("radiogroup", { name: "工厂运行模式" });
  const demo = group.getByRole("radio", { name: "演示模式" }),
    live = group.getByRole("radio", { name: "实时工厂" });
  await expect(demo).toBeChecked();
  await expect(live).toBeEnabled();
  await demo.focus();
  await demo.press("ArrowRight");
  await expect(live).toBeChecked();
  await expect(
    card.getByText("从企业中台读取工单、运行动态和交付物。"),
  ).toBeVisible();
  await page.setViewportSize({ width: 412, height: 780 });
  const address = card.getByLabel("工厂控制面地址"),
    token = card.getByLabel("工厂管理员令牌");
  await expect(address).toBeVisible();
  await expect(token).toBeVisible();
  const a = (await address.boundingBox())!,
    b = (await token.boundingBox())!;
  expect(a.x).toBe(b.x);
  expect(a.width).toBe(b.width);
  expect(a.height).toBeGreaterThanOrEqual(36);
  expect(a.x + a.width).toBeLessThanOrEqual(412);
  const shelf = page
    .locator(".sidebar-footer")
    .getByRole("button", { name: "资料筐", exact: true });
  await expect(shelf).toBeVisible();
  expect(await shelf.evaluate((e) => e.closest("nav") === null)).toBe(true);
});
