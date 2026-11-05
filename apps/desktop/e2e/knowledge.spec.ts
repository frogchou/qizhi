import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let callbackId = 1;
    const callbacks = new Map<number, (data: unknown) => void>();
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
      invoke: (command) => {
        if (command === "get_settings") return Promise.resolve([]);
        if (command === "list_ragflow_datasets")
          return Promise.resolve([
            { id: "kb-1", name: "工作知识库", description: "项目资料" },
          ]);
        if (command === "list_ragflow_agents")
          return Promise.resolve([
            { id: "agent-1", name: "工作助手", description: "项目分析" },
          ]);
        if (command === "query_ragflow_knowledge")
          return Promise.resolve({
            chunks: [],
            retrievalError: null,
            agentResults: [
              {
                agentId: "agent-1",
                answer: "## 回答\n\n这是结构化的 **Markdown** 回答。",
                error: null,
                sessionId: "session-1",
                sessionInvalid: false,
                steps: [
                  {
                    title: "检索资料",
                    nodeType: "retrieval",
                    status: "completed",
                    elapsedMs: 120,
                    error: null,
                  },
                ],
              },
            ],
          });
        return Promise.resolve(null);
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "知识库" }).click();
  await page.getByText("知识库（0）").click();
  await page.getByRole("checkbox", { name: "工作知识库" }).check();
  await page.getByText("Agents（0）").click();
  await page.getByLabel("工作助手").check();
});

test("uses a polished chat layout and keeps edit as composer-only", async ({
  page,
}) => {
  const composer = page.getByLabel("询问你的工作知识库");
  await composer.fill("请总结项目进度");
  await composer.press("Enter");

  const user = page.locator(".user-message-bubble");
  const answer = page.locator(".agent-answer");
  await expect(answer.getByRole("heading", { name: "回答" })).toBeVisible();
  const userBox = await user.boundingBox();
  const answerBox = await answer.boundingBox();
  expect(userBox).not.toBeNull();
  expect(answerBox).not.toBeNull();
  expect(userBox!.x).toBeGreaterThan(answerBox!.x);

  const process = answer.locator("details.agent-execution");
  await expect(process).not.toHaveAttribute("open", "");
  await expect(page.getByText("检索资料")).not.toBeVisible();

  await page.getByRole("button", { name: "编辑 请总结项目进度" }).click();
  await expect(page.getByLabel("继续提问")).toHaveValue("请总结项目进度");
  await expect(page.locator(".user-message")).toHaveCount(1);
});

test("does not create horizontal overflow on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 720 });
  const composer = page.getByLabel("询问你的工作知识库");
  await composer.fill("x".repeat(180));
  await composer.press("Enter");
  const dimensions = await page
    .locator(".knowledge-conversation")
    .evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
});
