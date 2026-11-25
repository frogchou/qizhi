import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          if (command === "factory_get_settings")
            return { mode: "demo", endpoint: "", hasToken: false };
          throw new Error("演示测试未连接其他桌面服务");
        },
      },
    });
  });
});

test("总览、节点恢复、人工返工和交付", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "全厂总览", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "暂停模拟" }).click();
  await page.locator(".fc-stats .blocked").click();
  await page
    .locator(".fc-list button")
    .filter({ hasText: "供应商资料汇总" })
    .click();
  await page.getByRole("button", { name: "重试此节点" }).click();
  await expect(page.locator(".fc-inspector > .fc-badge")).toHaveText("工作中");
  await page.getByRole("button", { name: "查看执行日志" }).click();
  await expect(page.getByRole("dialog")).toContainText("重新尝试");
  await page.keyboard.press("Escape");
  await page.locator(".fc-stats .review").click();
  await page.locator(".fc-list button").filter({ hasText: "年度方案" }).click();
  await page.getByRole("button", { name: "退回制作" }).click();
  await expect(page.locator(".fc-steps .current")).toContainText("制作成果");
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "继续模拟" }).click();
  await page.clock.runFor(34000);
  await page.getByRole("button", { name: "批准交付" }).click();
  await page.getByRole("button", { name: "查看交付单", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("年度方案质量复核");
});

test("提交需求后跟随同一工单并自动交付", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: /新建需求/ }).click();
  await page.getByLabel("需求内容").fill("制作一个产品演示");
  await page.getByLabel("质检完成后由我审批").uncheck();
  await page.getByRole("button", { name: "提交并跟随" }).click();
  await expect(page.locator(".fc-inspector h2")).toHaveText("制作一个产品演示");
  await expect(page.getByRole("button", { name: "跟随工单" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.clock.runFor(48000);
  await expect(page.locator(".fc-inspector > .fc-badge")).toHaveText("已交付");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "智能工厂", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "全厂总览", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /成果交付中心，/ }).click();
  await expect(page.locator(".fc-list")).toContainText("制作一个产品演示");
});

test("园区总览按工单驱动交通、设备与悬浮详情", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("checkbox", { name: "模拟来单" }).uncheck();
  await expect(page.locator(".fc-inspector")).toBeHidden();
  const vehicle = page.locator('[data-actor="vehicle"]').first();
  await expect(vehicle).toHaveAttribute("transform", /translate/);
  await expect(page.locator('[data-actor="worker"]')).toHaveCount(6);
  const first = await vehicle.getAttribute("transform");
  await expect.poll(() => vehicle.getAttribute("transform")).not.toBe(first);
  await page.getByRole("button", { name: "暂停模拟" }).click();
  const river = page.locator(".eco-ripple").first();
  await expect(river).toHaveCSS("animation-play-state", "paused");
  await expect(page.locator('[data-layer="hologram"]')).toBeVisible();
  const frozen = await vehicle.getAttribute("transform");
  await page.waitForTimeout(140);
  expect(await vehicle.getAttribute("transform")).toBe(frozen);
  const display = page.locator('[data-equipment="runtime"]').first();
  await expect(display).toHaveAttribute("data-loaded", "true");
  expect(
    await display
      .locator(".fc-level")
      .first()
      .evaluate((el) => getComputedStyle(el).animationPlayState),
  ).toBe("paused");
  await page.locator('[data-area="assets"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("4 个模拟知识库");
  await page.locator('[data-area="line"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("栖知产品介绍 PPT");
  await page.clock.install();
  await page.getByRole("button", { name: "继续模拟" }).click();
  await page.clock.runFor(34000);
  await expect(display).toHaveAttribute("data-loaded", "false");
  await expect(
    page.locator('[data-equipment="control"] .fc-face'),
  ).toBeVisible();
});

test("运行中的园区响应系统减少动态偏好", async ({ page }) => {
  await page.goto("/");
  const vehicle = page.locator('[data-actor="vehicle"]').first();
  const river = page.locator(".eco-ripple").first();
  const before = await vehicle.getAttribute("transform");
  await expect.poll(() => vehicle.getAttribute("transform")).not.toBe(before);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".fc-traffic")).toHaveAttribute(
    "data-motion",
    "still",
  );
  await expect(river).toHaveCSS("animation-name", "none");
  const still = await vehicle.getAttribute("transform");
  await page.waitForTimeout(1200);
  expect(await vehicle.getAttribute("transform")).toBe(still);
});

test("演示生产线按模拟执行显示工单，版本目录说明数据来源", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "暂停模拟" }).click();
  await page.getByRole("button", { name: /^智能体生产线，/ }).click();
  const panel = page.getByRole("complementary", { name: "工单面板" });
  await expect(panel.getByRole("tab")).toHaveText([
    "正在运行",
    "已上线",
    "待审核",
  ]);
  await expect(panel.getByText("共 1 个模拟运行实例")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /栖知产品介绍 PPT/ }),
  ).toBeVisible();
  await expect(panel.getByText("供应商资料汇总")).toHaveCount(0);
  for (const name of ["已上线", "待审核"]) {
    await panel.getByRole("tab", { name }).click();
    await expect(panel.getByRole("tabpanel")).toContainText(
      "演示模式未连接版本目录",
    );
    await expect(panel.getByRole("combobox")).toHaveCount(0);
  }
  await panel.getByRole("tab", { name: "正在运行" }).click();
  await panel.getByRole("button", { name: /栖知产品介绍 PPT/ }).click();
  await expect(
    panel.getByRole("heading", { name: "栖知产品介绍 PPT" }),
  ).toBeVisible();
});

for (const width of [1280, 1024, 412]) {
  test(`资产仓抽屉覆盖地图并可直达知识库（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1024 ? 680 : 820 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const map = page.locator(".fc-plate");
    const asset = page.locator('[data-area="assets"]');
    const before = await map.boundingBox();
    expect(before).not.toBeNull();
    const drawer = page.getByRole("complementary", { name: "工单面板" });
    await asset.click();
    await expect(
      drawer.getByRole("heading", { name: "企业资产仓" }),
    ).toBeVisible();
    expect(await map.boundingBox()).toEqual(before);
    const box = await drawer.boundingBox();
    expect(box!.x).toBeLessThan(before!.x + before!.width);
    expect(box!.x).toBeGreaterThan(before!.x);
    expect(box!.y).toBeLessThan(before!.y + before!.height);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    expect(await map.boundingBox()).toEqual(before);
    await expect(asset).toBeFocused();
    await asset.click();
    await drawer.getByRole("button", { name: "关闭抽屉" }).click();
    await expect(drawer).toBeHidden();
    await asset.click();
    await drawer.getByRole("button", { name: "打开栖知知识库" }).click();
    await expect(
      page.locator(".workspace.knowledge-workspace-shell .knowledge-page"),
    ).toBeVisible();
    await page.getByRole("button", { name: "智能工厂", exact: true }).click();
    await expect(drawer).toBeHidden();
    expect(await map.boundingBox()).toEqual(before);
  });
}

test("河谷底图、模拟来单与工单灯效联动", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  const image = page.locator(".fc-plate > img");
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBe(1833);
  await expect(page.locator(".eco-ripple").first()).toHaveCSS(
    "animation-play-state",
    "running",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.runFor(8000);
  await expect(page.locator('[data-layer="hologram"]')).toHaveAttribute(
    "data-planning",
    "true",
  );
  await expect(
    page.locator('.eco-flows [data-flow="live"][data-kind="task"]'),
  ).toHaveCount(1);
  expect(await page.locator(".eco-note").count()).toBeLessThanOrEqual(2);
  await expect(page.locator(".eco-note").first()).toBeVisible();
  await page.getByRole("checkbox", { name: "模拟来单" }).uncheck();
  await page.clock.runFor(60000);
  await expect(page.locator(".eco-flows [data-flow=live]")).toHaveCount(0);
  await expect(page.locator(".eco-note")).toHaveCount(0);
});
