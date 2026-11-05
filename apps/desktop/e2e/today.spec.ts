import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let callbackId = 1;
    const callbacks = new Map<number, (data: unknown) => void>();
    const samples = [
      { name: "周报-01.docx", status: "待分析" },
      { name: "制度文档-02.PDF", status: "有价值" },
      { name: "预算分析-03.xlsx", status: "低价值" },
      { name: "项目计划-04.pptx", status: "无法解析" },
      { name: "README-05.md", status: "评估失败" },
      {
        name: "这是一个用于验证长文件名不会挤压右侧操作列的组件实现-06.tsx",
        status: "有价值",
      },
    ];
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => unknown;
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
      invoke: (command, args) => {
        if (command === "get_today_snapshot" || command === "refresh_today")
          return Promise.resolve({
            state: "ready",
            files: Array.from({ length: 80 }, (_, index) => ({
              id: index + 1,
              canonicalPath: `D:\\工作\\${samples[index]?.name ?? `周报-${String(index + 1).padStart(2, "0")}.docx`}`,
              modifiedAtUtcMs: 1793189400000 - index * 60_000,
              sizeBytes: 1024 + index,
              source: "本机 NTFS 索引",
              status: samples[index]?.status ?? "待分析",
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
        if (command === "query_today_workspace") {
          const input = args?.input as {
            category?: string;
            search?: string;
            sort?: string;
          };
          const documentExtensions = new Set([
            "docx",
            "pdf",
            "xlsx",
            "pptx",
            "md",
          ]);
          let values = Array.from({ length: 80 }, (_, index) => {
            const sample = samples[index];
            const name =
              sample?.name ?? `周报-${String(index + 1).padStart(2, "0")}.docx`;
            const status = sample?.status ?? "待分析";
            const valueSummary = {
              valuable: status === "有价值" ? 1 : 0,
              notValuable: status === "低价值" ? 1 : 0,
              pending: status === "待分析" ? 1 : 0,
              failed: status === "评估失败" ? 1 : 0,
              unsupported: status === "无法解析" ? 1 : 0,
            };
            return {
              id: `f:${index + 1}`,
              kind: "file",
              name,
              canonicalPath: `D:\\工作\\${name}`,
              fileId: index + 1,
              modifiedAtUtcMs: 1793189400000 - index * 60_000,
              sizeBytes: 1024 + index,
              source: "本机 NTFS 索引",
              fileCount: 1,
              childDirectoryCount: 0,
              hasChildren: false,
              valueSummary,
            };
          });
          values = values.filter((entry) => {
            const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
            if (input.category === "documents")
              return documentExtensions.has(extension);
            if (input.category === "sourceCode")
              return !documentExtensions.has(extension);
            return true;
          });
          const needle = input.search?.replaceAll("*", "").replaceAll("?", "");
          if (needle)
            values = values.filter((entry) =>
              entry.name.toLowerCase().includes(needle.toLowerCase()),
            );
          if (input.sort === "nameAsc")
            values.sort((left, right) => left.name.localeCompare(right.name));
          return Promise.resolve({
            queryId: `workspace-${input.category ?? "all"}-${input.search ?? ""}`,
            totalFileCount: values.length,
            nextCursor: null,
            entries: [
              {
                id: "project-a",
                kind: "directory",
                name: "项目A",
                canonicalPath: "D:\\工作\\项目A",
                fileId: null,
                modifiedAtUtcMs: 1793189400000,
                sizeBytes: 4096,
                source: "本机 NTFS 索引",
                fileCount: 79,
                childDirectoryCount: 1,
                hasChildren: true,
                valueSummary: {
                  valuable: 28,
                  notValuable: 51,
                  pending: 0,
                  failed: 0,
                  unsupported: 0,
                },
              },
              ...values,
            ],
          });
        }
        if (command === "expand_today_workspace")
          return Promise.resolve({
            queryId: "workspace-documents-",
            totalFileCount: 80,
            nextCursor: null,
            entries: [
              {
                id: "project-a-src",
                kind: "directory",
                name: "src",
                canonicalPath: "D:\\工作\\项目A\\src",
                fileId: null,
                modifiedAtUtcMs: 1793189400000,
                sizeBytes: 4096,
                source: "本机 NTFS 索引",
                fileCount: 8,
                childDirectoryCount: 0,
                hasChildren: true,
                valueSummary: {
                  valuable: 2,
                  notValuable: 1,
                  pending: 5,
                  failed: 0,
                  unsupported: 0,
                },
              },
            ],
          });
        if (command === "evaluate_workspace_query")
          return Promise.resolve({
            evaluated: 0,
            valuable: 0,
            notValuable: 0,
            failed: 0,
            unsupported: 0,
          });
        if (command === "prepare_work_summary")
          return Promise.resolve({
            fileCount: 1,
            batchCount: 1,
            requiresConfirmation: false,
          });
        if (command === "generate_work_summary") {
          const channel = args?.onEvent as {
            onmessage?: (event: unknown) => void;
          };
          channel.onmessage?.({
            kind: "started",
            templateTitle: "今日工作总结",
            fileCount: 1,
          });
          setTimeout(
            () =>
              channel.onmessage?.({
                kind: "delta",
                delta:
                  "# 今日成果\n\n- **完成了本地索引优化**\n\n**事实: **我已完成目录聚合。",
              }),
            120,
          );
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  markdown:
                    "# 今日成果\n\n- **完成了本地索引优化**\n\n**事实: **我已完成目录聚合。",
                  truncated: false,
                  fileCount: 1,
                  templateTitle: "今日工作总结",
                }),
              300,
            ),
          );
        }
        if (command === "list_scan_rules")
          return Promise.resolve({
            allowedRoots: [],
            customExclusions: [],
            fileCategories: ["documents", "sourceCode"],
            lockedExclusions: [],
          });
        if (command === "pick_folder") return Promise.resolve(null);
        if (command === "reveal_in_explorer") return Promise.resolve();
        if (command === "evaluate_today_files") return Promise.resolve([]);
        return Promise.resolve({ available: false, message: "后续版本启用" });
      },
    };
  });
});

test("summary opens immediately, streams formatted Markdown, and keeps a rounded split action", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.getByLabel("选择 周报-01.docx").check();

  const group = page.getByRole("group", { name: "今日总结操作" });
  const geometry = await group.evaluate((element) => {
    const style = getComputedStyle(element);
    const arrow = element.querySelector("svg");
    return {
      borderRadius: style.borderRadius,
      overflow: style.overflow,
      arrowWidth: arrow?.getBoundingClientRect().width,
    };
  });
  expect(geometry.borderRadius).toBe("9px");
  expect(geometry.overflow).toBe("hidden");
  expect(geometry.arrowWidth).toBeGreaterThanOrEqual(18);

  await page.getByRole("button", { name: "生成今日总结" }).click();
  await expect(page.getByRole("dialog", { name: "工作总结" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制" })).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "今日成果", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".summary-markdown strong")).toHaveText([
    "完成了本地索引优化",
    "事实:",
  ]);
  await expect(page.locator(".summary-markdown")).not.toContainText("**事实:");
  await expect(page.getByRole("button", { name: "复制" })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("summary-streaming-dialog.png"),
  });
});

test("today file table stays compact and scrolls inside the workspace", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 820 });
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
  await page.screenshot({
    path: testInfo.outputPath("today-1280x820.png"),
  });
});

test("today table keeps all columns visible at the minimum desktop viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await page.goto("/");
  await expect(page.getByText("周报-01.docx")).toBeVisible();

  await expect(page.locator('[data-file-kind="pdf"]')).toBeVisible();
  await expect(page.locator('[data-file-kind="sheet"]')).toBeVisible();
  await expect(page.locator('[data-file-kind="slides"]')).toBeVisible();
  await expect(page.locator('[data-file-kind="markdown"]')).toBeVisible();
  await expect(page.locator('[data-file-kind="code"]')).toHaveCount(0);
  await expect(page.locator(".status-valuable").first()).toBeVisible();
  await expect(page.locator(".status-low")).toBeVisible();
  await expect(page.locator(".status-unsupported")).toBeVisible();
  await expect(page.locator(".status-error")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "操作" })).toBeVisible();

  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    tableWidth: document.querySelector(".file-table")?.getBoundingClientRect()
      .width,
    viewportTableWidth: document
      .querySelector(".file-table-wrap")
      ?.getBoundingClientRect().width,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.tableWidth).toBeLessThanOrEqual(layout.viewportTableWidth ?? 0);
  await page.screenshot({
    path: testInfo.outputPath("today-1024x680.png"),
  });

  await page.getByLabel("文件类型筛选").selectOption("sourceCode");
  await expect(page.locator('[data-file-kind="code"]')).toBeVisible();
  await expect(page.locator('[data-file-kind="pdf"]')).toHaveCount(0);
  await page.getByLabel("文件类型筛选").selectOption("all");
  await page.getByLabel("排序方式").selectOption("name-asc");
  await expect(page.locator(".file-table tbody tr").first()).toBeVisible();
});

test("directory activity expands lazily and search clears its selection", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByText("项目A")).toBeVisible();

  const directoryRow = page.locator(".workspace-directory-row").first();
  const directoryLayout = await directoryRow.evaluate((row) => {
    const summary = row.querySelector(".directory-value-summary");
    const action = row.querySelector(".row-open");
    const summaryBox = summary?.getBoundingClientRect();
    const actionBox = action?.getBoundingClientRect();
    return {
      summaryRight: summaryBox?.right ?? Number.POSITIVE_INFINITY,
      actionLeft: actionBox?.left ?? Number.NEGATIVE_INFINITY,
    };
  });
  expect(directoryLayout.summaryRight).toBeLessThanOrEqual(
    directoryLayout.actionLeft,
  );

  await page.getByRole("button", { name: "展开 项目A" }).click();
  await expect(page.getByText("src", { exact: true })).toBeVisible();
  await page.getByLabel("选择 项目A").check();
  await expect(page.getByText(/已选 1 项/)).toBeVisible();

  await page.getByLabel("按文件名搜索").fill("周报-01*");
  await expect(page.getByText(/已选 0 项/)).toBeVisible();
  await expect(page.getByText("周报-01.docx")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("directory-value-column.png"),
  });
});
