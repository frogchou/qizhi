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
            files: Array.from({ length: 80 }, (_, index) => ({
              id: index + 1,
              canonicalPath: `D:\\工作\\周报-${String(index + 1).padStart(2, "0")}.docx`,
              modifiedAtUtcMs: 1793189400000 - index * 60_000,
              sizeBytes: 1024 + index,
              source: "本机 NTFS 索引",
              status: "待分析",
            })),
            clusters: [
              {
                label: "本机 NTFS 索引",
                fileIds: Array.from({ length: 80 }, (_, index) => index + 1),
              },
            ],
          });
        if (command === "get_ntfs_indexer_status")
          return Promise.resolve({
            available: true,
            message: "本地 NTFS 索引服务已连接。",
          });
        if (command === "get_settings") return Promise.resolve([]);
        if (command === "list_scan_rules")
          return Promise.resolve({
            allowedRoots: [],
            customExclusions: [],
            fileCategories: ["documents", "sourceCode"],
            lockedExclusions: [],
          });
        if (command === "pick_folder") return Promise.resolve(null);
        if (command === "reveal_in_explorer") return Promise.resolve();
        return Promise.resolve({ available: false, message: "后续版本启用" });
      },
    };
  });
});

test("today file table stays compact and scrolls inside the workspace", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("周报-01.docx")).toBeVisible();

  const tableViewport = page.locator(".file-table-wrap");
  await expect(tableViewport).toBeVisible();
  expect(
    await tableViewport.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);

  const firstRowHeight = await page
    .locator(".file-table tbody tr")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(firstRowHeight).toBeLessThanOrEqual(40);
  await expect(page.getByText("1 KB", { exact: true })).toHaveCount(0);
});
