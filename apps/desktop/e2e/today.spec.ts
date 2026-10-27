import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string) => unknown };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: (command) => {
        if (command === "get_today_snapshot" || command === "refresh_today")
          return Promise.resolve({
            state: "ready",
            files: [
              {
                id: 7,
                canonicalPath: "D:\\工作\\周报.docx",
                modifiedAtUtcMs: 1793189400000,
                sizeBytes: 1024,
                source: "本机文件",
                status: "待分析",
              },
            ],
            clusters: [{ label: "本机文件", fileIds: [7] }],
          });
        if (command === "get_everything_status")
          return Promise.resolve({
            available: false,
            adapter: "unavailable",
            remediation: "未检测到 Everything。",
          });
        if (command === "get_settings") return Promise.resolve([]);
        if (command === "reveal_in_explorer") return Promise.resolve();
        return Promise.resolve({ available: false, message: "后续版本启用" });
      },
    };
  });
});

test("stage 0-1: navigates today settings today and keeps upload disabled", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("周报.docx")).toBeVisible();
  await page.getByText("周报.docx").click();
  await expect(
    page.getByRole("button", { name: "加入知识库（后续版本）" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.getByRole("button", { name: "今日" }).click();
  await expect(
    page.getByRole("heading", { name: "今天产生的文件" }),
  ).toBeVisible();
});
