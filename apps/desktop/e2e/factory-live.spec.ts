import { expect, test, type Page } from "@playwright/test";

// This fixture is confined to Playwright. Every observation and write uses the same desktop command surface as a packaged client.
type Call = {
  method?: string;
  idempotencyKey?: string;
  itemId?: string;
  path?: string;
  body?: Record<string, unknown>;
  taskId?: string;
  artifactId?: string;
  fileName?: string;
};
type Fixture = {
  calls: Call[];
  events: {
    id: number;
    taskId: string;
    kind: string;
    state: string;
    message: string;
    source: string;
    occurredAt: string;
  }[];
  disconnect: boolean;
  failNextAmend?: boolean;
  deleted?: boolean;
  deleting?: boolean;
  blockDeletion?: boolean;
  revokeFails?: boolean;
  stopped?: string[];
  release?: {
    agentId: string;
    version: string;
    displayName: string;
    status: string;
  };
};
declare global {
  interface Window {
    factoryLiveFixture: Fixture;
  }
}
async function install(page: Page) {
  await page.addInitScript(() => {
    const now = () => new Date().toISOString();
    const state: Fixture = { calls: [], events: [], disconnect: false };
    window.factoryLiveFixture = state;
    const names = {
      intake: "已接单 2 张",
      control: "已编排 1 张",
      line: "1 个在册智能体，1 个工作中",
      quality: "1 张待人工验收",
      runtime: "1 个运行实例",
      assets: "配置了 1 个知识库",
      monitor: "最近心跳正常",
      delivery: "1 张已验收交付",
    };
    const areaMetrics = {
      intake: { tasks: 2, received: 0, qizhiDesktop: 2, channels: 1 },
      control: { planning: 0, planned: 0, plans: 1 },
      line: {
        agents: 1,
        runningAgents: 1,
        runningNodes: 1,
        activeTasks: 1,
        retrievingNodes: 1,
        pendingReviewVersions: 0,
      },
      quality: { pendingReview: 1, checking: 0, failed: 0, automaticPassed: 1 },
      runtime: { active: 1, planning: 0, readyRuntimes: 1, attempts: 1 },
      assets: {
        configuredDatasets: 1,
        connectedDatasets: 1,
        inputs: 3,
        artifacts: 1,
      },
      monitor: { events: 1, heartbeats: 1, staleInstances: 0 },
      delivery: { accepted: 1, artifacts: 1, withArtifacts: 1 },
    };
    const connection = {
      status: "connected",
      message: "RAGFlow 已连接",
      observedAt: now(),
    };
    const event = {
      id: 7,
      taskId: "task-with-review",
      kind: "agent_heartbeat",
      state: "running",
      message: "已收到审核实例心跳",
      source: "agent",
      occurredAt: now(),
    };
    let reviewed = false;
    const task = (id: string) => ({
      id,
      taskId: id,
      goal:
        id === "task-new"
          ? "核对收货报告"
          : id === "task-delivered"
            ? "已归档供应商答复"
            : id === "task-running"
              ? "正在执行的资料检索"
              : "采购文件审核",
      state: state.stopped?.includes(id)
        ? "cancelled"
        : id === "task-delivered" || (id === "task-with-review" && reviewed)
          ? "accepted"
          : id === "task-running"
            ? "running"
            : "awaiting_review",
      sourceSystem: id === "task-delivered" ? "api" : "qizhi_desktop",
      acceptanceMode: "human_review",
      planVersion: 2,
      createdAt: now(),
      updatedAt: now(),
    });
    const demoAgent = {
      agentId: "audit-assistant",
      version: "1.0.0",
      displayName: "审计助理",
      status: "ready",
    };
    const agents = () =>
      [
        ...(state.deleted
          ? []
          : [demoAgent, { ...demoAgent, version: "0.9.0", status: "offline" }]),
        ...(state.release ? [state.release] : []),
      ].map((a) => ({
        ...a,
        status:
          a.agentId === demoAgent.agentId && state.deleting
            ? "deleting"
            : a.status,
        id: a.agentId + "@" + a.version,
        runtime: "codex",
        createdAt: now(),
        approvedAt: now(),
        runningCount: 1,
        capabilities: [
          { name: "knowledge.retrieve", description: "检索机构档案" },
        ],
      }));
    const readPage = (items: unknown[]) => ({
      items,
      total: items.length,
      limit: 20,
      offset: 0,
      observedAt: now(),
    });
    const rpc = async (command: string, args: Call = {}) => {
      const receipt = (id: string, displayName: string) => ({
        id,
        displayName,
        originalFilename: displayName,
        mediaType: "text/plain",
        sizeBytes: 42,
        sha256: "a".repeat(64),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      if (command === "basket_list")
        return [
          {
            id: "basket-test-chunk",
            kind: "ragflowChunk",
            displayName: "实施目标片段.md",
            sourceLabel: "项目库",
            sizeBytes: 42,
            sha256: "a".repeat(64),
            addedAtUtcMs: Date.now(),
          },
        ];
      if (command === "factory_pick_uploads")
        return [
          {
            displayName: "新增说明.txt",
            status: "uploaded",
            upload: receipt("local-upload", "新增说明.txt"),
            error: null,
          },
        ];
      if (command === "factory_upload_basket_item") {
        state.calls.push({ method: command, itemId: args.itemId });
        return receipt("basket-upload", "实施目标片段.md");
      }
      if (command === "factory_get_settings")
        return {
          mode: "live",
          endpoint: "http://127.0.0.1:3010",
          hasToken: true,
        };
      if (command === "list_model_providers")
        return [
          {
            providerId: "openai",
            displayName: "OpenAI / OpenAI 兼容",
            endpoint: "https://api.openai.com/v1",
            model: "gpt-5.6-sol",
            apiKeyMask: "••••••••",
            supportsResponses: true,
            isActive: true,
            updatedAtUtcMs: 1,
          },
        ];
      if (command === "get_active_model_provider")
        return {
          providerId: "openai",
          displayName: "OpenAI / OpenAI 兼容",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-5.6-sol",
          apiKeyMask: "••••••••",
          supportsResponses: true,
          isActive: true,
          updatedAtUtcMs: 1,
        };
      if (command === "factory_download") {
        state.calls.push({ method: "DOWNLOAD", ...args });
        return true;
      }
      if (command !== "factory_request") {
        if (
          [
            "list_ragflow_datasets",
            "list_ragflow_agents",
            "factory_cancel_read",
          ].includes(command)
        )
          return [];
        throw new Error("测试中未连接此桌面服务");
      }
      state.calls.push(args);
      if (state.disconnect) throw new Error("中台暂时不可用");
      const url = new URL(args.path!, "http://factory.test"),
        path = url.pathname;
      if (args.method === "POST") {
        if (path.endsWith("/stop")) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const id = path.split("/")[3];
          state.stopped = Array.from(new Set([...(state.stopped ?? []), id]));
          return { state: "cancelled" };
        }
        if (path === "/v1/factory/agents/audit-assistant/delete") {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (state.blockDeletion)
            throw new Error("该智能体仍被工单 task-running 占用（HTTP 409）");
          if (state.revokeFails) {
            state.deleting = true;
            throw new Error(
              "部分节点撤销失败，智能体删除中，可重试（HTTP 503）",
            );
          }
          state.deleting = false;
          state.deleted = true;
          return {
            agentId: "audit-assistant",
            status: "deleted",
            versionCount: 2,
          };
        }
        if (path === "/v1/tasks")
          return { taskId: "task-new", state: "received" };
        if (path.endsWith("/review")) {
          if (
            args.body?.decision === "revise" ||
            args.body?.decision === "amend"
          ) {
            if (state.failNextAmend) {
              state.failNextAmend = false;
              throw new Error("网络暂时不可用");
            }
            return {
              taskId: path.split("/")[3],
              state: "planning",
              decision: args.body.decision,
              revisionId: "new-revision",
              revisionNumber: 1,
            };
          }
          reviewed = true;
          return { state: "accepted" };
        }
        if (path.endsWith("/releases")) {
          state.release = {
            agentId: String(args.body!.agentId ?? "installed-agent"),
            version: String(args.body!.version ?? "3.0.0"),
            displayName: String(args.body!.displayName ?? "现有安装包"),
            status: "pending_review",
          };
          return state.release;
        }
        if (path.endsWith("/approve") && state.release) {
          state.release.status = "ready";
          return state.release;
        }
        if (path.endsWith("/offline") && state.release) {
          state.release.status = "offline";
          return state.release;
        }
      }
      if (path.endsWith("/overview"))
        return {
          cursor: String(state.events.length),
          observedAt: now(),
          recentActivities: [event],
          areas: Object.fromEntries(
            Object.entries(names).map(([key, summary]) => [
              key,
              {
                count: 1,
                summary,
                metrics: areaMetrics[key as keyof typeof areaMetrics],
                ...(key === "assets" ? { connection } : {}),
              },
            ]),
          ),
        };
      if (path.endsWith("/changes")) {
        await new Promise((r) => setTimeout(r, 250));
        if (state.disconnect) throw new Error("中台暂时不可用");
        return {
          items: state.events.slice(Number(url.searchParams.get("after")) || 0),
          registryChanges: [],
          cursor: String(state.events.length),
          hasMore: false,
          observedAt: now(),
        };
      }
      if (path === "/v1/factory/tasks") {
        const get = (name: string) => url.searchParams.get(name);
        return readPage(
          ["task-with-review", "task-running", "task-delivered"]
            .map(task)
            .filter(
              (row) =>
                (!get("area") ||
                  (get("area") === "line"
                    ? row.state === "running"
                    : !["cancelled", "accepted"].includes(row.state))) &&
                (!get("sourceSystem") ||
                  get("sourceSystem") === row.sourceSystem) &&
                (!get("state") || get("state") === row.state),
            ),
        );
      }
      if (path === "/v1/factory/quality") {
        const q = {
          id: "q-9",
          taskId: "task-with-review",
          goal: "采购文件审核",
          state: "awaiting_review",
          status: "pending_review",
          reviewId: "round-real-9",
          round: 3,
          verdict: "uncertain",
          acceptanceMode: "human_review",
          missingCount: 1,
          uncertainCount: 1,
          reportedGaps: ["缺少原件"],
        };
        const status = url.searchParams.get("status");
        return readPage(
          [
            q,
            {
              ...q,
              id: "q-running",
              taskId: "task-running",
              goal: "正在执行的资料检索",
              state: "running",
              status: "checking",
            },
            {
              ...q,
              id: "q-accepted",
              taskId: "task-delivered",
              goal: "已归档供应商答复",
              state: "accepted",
              status: "accepted",
            },
          ].filter(
            (row) =>
              !status ||
              (status === "pending_quality"
                ? ["checking", "pending_review"].includes(row.status)
                : row.status === status),
          ),
        );
      }
      if (path === "/v1/factory/sources")
        return readPage([
          {
            id: "qizhi_desktop",
            displayName: "栖知桌面端",
            status: "available",
            taskCount: 2,
            lastReceivedAt: now(),
          },
          {
            id: "feishu",
            displayName: "飞书",
            status: "not_connected",
            taskCount: 0,
            lastReceivedAt: null,
          },
        ]);
      if (path === "/v1/factory/assets")
        return {
          ...readPage([
            {
              id: "ds-1",
              name: "采购手册",
              configured: true,
              documentCount: 13,
              chunkCount: 41,
            },
          ]),
          connection,
          metrics: { inputCount: 3, artifactCount: 1, sessionCount: 2 },
        };
      if (path === "/v1/factory/agents")
        return readPage(
          agents().filter(
            (a) =>
              (!url.searchParams.get("status") ||
                a.status === url.searchParams.get("status")) &&
              (!url.searchParams.get("agentId") ||
                a.agentId === url.searchParams.get("agentId")) &&
              (!url.searchParams.get("version") ||
                a.version === url.searchParams.get("version")),
          ),
        );
      if (path === "/v1/factory/packages")
        return readPage([
          {
            packageName: "installed-assistant",
            displayName: "尚未登记的包",
            agentId: "installed-agent",
            version: "3.0.0",
            status: null,
            declared: true,
          },
        ]);
      if (path === "/v1/factory/monitor") return readPage([event]);
      if (path === "/v1/factory/runtimes")
        return {
          ...readPage([
            {
              id: "attempt-3",
              instanceId: "worker-42",
              taskId: "task-with-review",
              goal: "采购文件审核",
              nodeKey: "retrieve",
              runtime: "codex",
              agentId: "audit-assistant",
              agentVersion: "1.0.0",
              state: "leased",
              lastHeartbeatAt: now(),
              metrics: {
                available: true,
                source: "cgroup v2",
                cpuUsageUsec: 40000,
                memoryBytes: 1048576,
                pidsCurrent: 3,
                observedAt: now(),
              },
            },
          ]),
          inventory: [
            {
              id: "codex",
              name: "Codex",
              readyVersionCount: 1,
              activeCount: 1,
              planningCount: 0,
              attemptCount: 3,
            },
          ],
        };
      if (path === "/v1/factory/deliveries")
        return readPage([
          {
            id: "delivery-1",
            taskId: "task-delivered",
            goal: "采购文件审核",
            state: "accepted",
            updatedAt: now(),
            artifactCount: 1,
            answer: "已核对采购文件",
          },
        ]);
      if (path.startsWith("/v1/tasks/")) {
        const t = task(path.split("/").pop()!);
        return {
          task: {
            ...t,
            state: t.state,
            acceptance_mode: "human_review",
            source_system: "qizhi_desktop",
            current_plan_version: 2,
            created_at: now(),
            updated_at: now(),
          },
          planSummary: { summary: "先检索再核对" },
          plans: [
            {
              id: "plan-2",
              version: 2,
              state: "compiled",
              created_at: now(),
              plan: { nodes: [{ id: "verify", dependsOn: ["retrieve"] }] },
            },
          ],
          nodes: [
            {
              id: "node-a",
              node_key: "verify",
              plan_id: "plan-2",
              state: "running",
              depends_on: ["retrieve"],
              agent_id: "audit-assistant",
              agent_version: "1.0.0",
              capability: "quality.define_and_verify",
              output: { output: { summary: "已核对采购文件" } },
            },
          ],
          attempts: [],
          activities: [event],
          inputs: [],
          artifacts: [
            {
              id: "actual-artifact",
              fileName: "核对结果.txt",
              mediaType: "text/plain",
              sizeBytes: 378,
              revision: 1,
              createdAt: now(),
              sha256: "abcd",
            },
          ],
          acceptanceRounds: [
            {
              id: "round-real-9",
              round: 3,
              decision: reviewed ? "accept" : null,
              created_at: now(),
              criteria: [{ id: "R2", requirement: "找到原件" }],
              assessment: {
                items: [{ id: "R2", status: "missing", reason: "缺少原件" }],
                reportedGaps: ["缺少原件"],
                evidence: [],
              },
            },
          ],
        };
      }
      throw new Error("未声明的测试接口 " + path);
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke: rpc },
    });
    Object.defineProperty(window, "isTauri", {
      configurable: true,
      value: true,
    });
  });
}
test.beforeEach(async ({ page }) => {
  await install(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByText("实时连接", { exact: false })).toBeVisible();
});
test("八栋楼读取真实接口，抽屉覆盖河谷并保留导航", async ({ page }) => {
  const map = page.locator(".fc-plate"),
    before = await map.boundingBox(),
    panel = page.getByRole("complementary", { name: "工厂详情面板" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  await expect(page).toHaveTitle(/栖知|Qizhi/i);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.locator('[data-area="line"]').hover();
  await expect(page.getByRole("tooltip")).toContainText("1 个工作中");
  for (const [area, expected] of [
    ["intake", "所有渠道的需求"],
    ["control", "采购文件审核"],
    ["line", "审计助理"],
    ["quality", "采购文件审核"],
    ["runtime", "1.0 MiB"],
    ["monitor", "已收到审核实例心跳"],
    ["delivery", "采购文件审核"],
    ["assets", "采购手册"],
  ]) {
    await page.locator('[data-area="' + area + '"]').click();
    await expect(panel).toContainText(expected);
    expect(await map.boundingBox()).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  }
  await page.locator('[data-area="assets"]').click();
  await panel.getByRole("button", { name: "打开栖知知识库" }).click();
  await expect(page.locator(".knowledge-page")).toBeVisible();
  expect(errors).toEqual([]);
});
test("验收传真实轮次，交付按任务和制品编号下载，新需求记录来源", async ({
  page,
}) => {
  const panel = page.locator(".live-inspector");
  await page.locator('[data-area="control"]').click();
  await panel.getByRole("button", { name: /采购文件审核/ }).click();
  await expect(panel).toContainText("先检索再核对");
  await expect(panel).toContainText("retrieve");
  await panel.getByRole("button", { name: "质检验收" }).click();
  await panel.getByRole("button", { name: "确认验收" }).click();
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls.find((c) => c.path?.endsWith("/review"))
          ?.body,
    ),
  ).toEqual({ decision: "accept", reviewId: "round-real-9" });
  await page.keyboard.press("Escape");
  await page.locator('[data-area="delivery"]').click();
  await panel.getByRole("button", { name: /采购文件审核/ }).click();
  await panel.getByRole("button", { name: "下载 核对结果.txt" }).click();
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.find((c) => c.method === "DOWNLOAD"),
    ),
  ).toMatchObject({
    taskId: "task-delivered",
    artifactId: "actual-artifact",
    fileName: "核对结果.txt",
  });
  await page.getByRole("button", { name: /新建需求/ }).click();
  await page.getByLabel("需求内容").fill("核对收货报告");
  await page.getByRole("button", { name: "提交并跟随" }).click();
  await expect(
    panel.getByRole("heading", { name: "核对收货报告" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls.find(
          (c) => c.method === "POST" && c.path === "/v1/tasks",
        )?.body,
    ),
  ).toMatchObject({
    goal: "核对收货报告",
    sourceSystem: "qizhi_desktop",
    acceptanceMode: "human_review",
  });
});
test("生产线托管新建、审核上线、下线和版本升级", async ({ page }) => {
  const panel = page.locator(".live-inspector"),
    dialog = page.getByRole("dialog");
  await page.locator('[data-area="line"]').click();
  await panel.getByRole("button", { name: "新建智能体" }).click();
  await dialog.getByLabel("智能体标识").fill("test-writer");
  await dialog.getByLabel("版本号").fill("1.0.0");
  await dialog.getByLabel("显示名称").fill("测试写作助理");
  await dialog.getByLabel("能力说明").fill("撰写简报");
  await dialog.getByLabel("执行指令").fill("依据资料撰写文本");
  await dialog.getByRole("button", { name: "创建并登记" }).click();
  await dialog.getByRole("button", { name: "查看版本详情" }).click();
  await panel.getByRole("button", { name: "审核并上线" }).click();
  await panel.getByRole("button", { name: "下线版本" }).click();
  await panel.getByRole("button", { name: "确认下线" }).click();
  await expect(
    panel.getByRole("button", { name: "重新审核上线" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "升级版本" }).click();
  await dialog.getByLabel("版本号").fill("1.1.0");
  await dialog.getByLabel("能力说明").fill("撰写与校对简报");
  await dialog.getByLabel("执行指令").fill("依据资料撰写并校对文本");
  await dialog.getByRole("button", { name: "登记升级版本" }).click();
  await expect(dialog).toContainText("v1.1.0");
  const releases = await page.evaluate(() =>
    window.factoryLiveFixture.calls
      .filter((c) => c.path?.endsWith("/releases"))
      .map((c) => c.body),
  );
  expect(releases).toMatchObject([
    { intent: "create", template: "codex-text", agentId: "test-writer" },
    { intent: "upgrade", version: "1.1.0", agentId: "test-writer" },
  ]);
});
test("手机宽度的实况抽屉可滚动，登记已安装的包使用服务器包名", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 820 });
  const map = page.locator(".fc-plate"),
    panel = page.locator(".live-inspector"),
    before = await map.boundingBox();
  await page.locator('[data-area="line"]').click();
  await expect(panel.getByRole("button", { name: /审计助理/ })).toBeVisible();
  expect(await map.boundingBox()).toEqual(before);
  await panel.getByRole("button", { name: "新建智能体" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("登记方式").selectOption("package");
  await dialog
    .getByLabel("已安装但尚未登记的包")
    .selectOption("installed-assistant");
  await dialog.getByRole("button", { name: "创建并登记" }).click();
  await expect(dialog).toContainText("installed-agent");
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls.find((c) =>
          c.path?.endsWith("/releases"),
        )?.body,
    ),
  ).toEqual({ packageName: "installed-assistant", intent: "create" });
});
test("实况连接直达设置，保留其他分类和尚未保存的连接草稿", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "主导航" }),
    categories = page.getByRole("navigation", { name: "设置分类" });
  await nav.getByRole("button", { name: "设置" }).click();
  await categories.getByRole("button", { name: "连接服务" }).click();
  await page.getByLabel("模型 Base URL").fill("https://draft.example.test/v1");
  await nav.getByRole("button", { name: "智能工厂" }).click();
  await page.getByRole("button", { name: "中台实况" }).click();
  await expect(
    categories.getByRole("button", { name: "智能工厂" }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByLabel("工厂控制面地址").fill("http://127.0.0.1:5321");
  await categories.getByRole("button", { name: "连接服务" }).click();
  await expect(page.getByLabel("模型 Base URL")).toHaveValue(
    "https://draft.example.test/v1",
  );
  await nav.getByRole("button", { name: "智能工厂" }).click();
  await page.getByRole("button", { name: "中台实况" }).click();
  await expect(page.getByLabel("工厂控制面地址")).toHaveValue(
    "http://127.0.0.1:5321",
  );
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.filter((c) => c.method === "POST"),
    ),
  ).toHaveLength(0);
});
test("断线标注快照，重连刷新，重复事件只显示一次", async ({ page }) => {
  await page.evaluate(() => {
    const e = {
      id: 8,
      taskId: "task-with-review",
      kind: "node_progress",
      state: "running",
      message: "实际节点刚更新",
      source: "agent",
      occurredAt: new Date().toISOString(),
    };
    window.factoryLiveFixture.events.push(e, e);
  });
  await expect(
    page.locator(".fc-events").getByText("实际节点刚更新"),
  ).toHaveCount(1);
  await page.evaluate(() => {
    window.factoryLiveFixture.disconnect = true;
  });
  await expect(page.getByText(/当前显示上次快照/)).toBeVisible();
  await expect(page.getByRole("button", { name: /新建需求/ })).toBeDisabled();
  const snapshots = await page.evaluate(
    () =>
      window.factoryLiveFixture.calls.filter(
        (c) => c.path === "/v1/factory/overview",
      ).length,
  );
  await page.evaluate(() => {
    window.factoryLiveFixture.disconnect = false;
  });
  await expect(page.getByText("实时连接", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls.filter(
          (c) => c.path === "/v1/factory/overview",
        ).length,
    ),
  ).toBeGreaterThan(snapshots);
});
test("接待页按渠道浏览，键盘可切换；中台与质检默认展示在办集合", async ({
  page,
}) => {
  const panel = page.locator(".live-inspector");
  await page.locator('[data-area="intake"]').click();
  const tasks = panel.getByRole("tab", { name: "需求列表" }),
    sources = panel.getByRole("tab", { name: "接入情况" });
  await expect(tasks).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByText("已归档供应商答复", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.filter((c) =>
        c.path?.startsWith("/v1/factory/sources"),
      ),
    ),
  ).toHaveLength(0);
  await tasks.focus();
  await tasks.press("ArrowRight");
  await expect(sources).toBeFocused();
  await expect(panel.getByText("未接入", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "查看飞书的需求" }).click();
  await expect(tasks).toBeFocused();
  await expect(panel.getByText("没有符合条件的工单")).toBeVisible();
  await panel.getByRole("button", { name: "查看所有渠道" }).click();
  await expect(
    panel.getByText("已归档供应商答复", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-area="control"]').click();
  await expect(panel.getByLabel("工单状态")).toHaveValue("in_progress");
  await expect(
    panel.getByText("正在执行的资料检索", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("已归档供应商答复", { exact: true }),
  ).toHaveCount(0);
  await panel.getByLabel("工单状态").selectOption("accepted");
  await expect(
    panel.getByText("已归档供应商答复", { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("工单状态").selectOption("");
  await expect(panel.getByText("采购文件审核", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-area="line"]').click();
  await expect(panel.getByLabel("版本状态")).toHaveValue("ready");
  await expect(panel.getByText(/v1.0.0/)).toBeVisible();
  await expect(panel.getByText(/v0.9.0/)).toHaveCount(0);
  await panel.getByLabel("版本状态").selectOption("");
  await expect(panel.getByText(/v0.9.0/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-area="quality"]').click();
  await expect(panel.getByLabel("质检结果")).toHaveValue("pending_quality");
  await expect(
    panel.getByText("正在执行的资料检索", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("采购文件审核", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("已归档供应商答复", { exact: true }),
  ).toHaveCount(0);
  await panel.getByLabel("质检结果").selectOption("pending_review");
  await expect(
    panel.getByText("正在执行的资料检索", { exact: true }),
  ).toHaveCount(0);
});
test("停止只作用于选中工单，可取消，重复确认只提交一次", async ({ page }) => {
  const panel = page.locator(".live-inspector");
  await page.locator('[data-area="control"]').click();
  await panel.getByRole("button", { name: /正在执行的资料检索/ }).click();
  await panel.getByRole("button", { name: "停止工单", exact: true }).click();
  const confirm = panel.getByRole("region", { name: "停止工单确认" });
  await expect(confirm).toContainText("task-running");
  await confirm.getByRole("button", { name: "取消" }).click();
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.filter((c) => c.path?.endsWith("/stop")),
    ),
  ).toHaveLength(0);
  await panel.getByRole("button", { name: "停止工单", exact: true }).click();
  await confirm
    .getByRole("button", { name: "确认停止工单" })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect(panel.getByText("中台已确认停止该工单。")).toBeVisible();
  await expect(panel.locator(".fc-badge").first()).toHaveText("已停止");
  const stops = await page.evaluate(() =>
    window.factoryLiveFixture.calls
      .filter((c) => c.path?.endsWith("/stop"))
      .map((c) => c.path),
  );
  expect(stops).toEqual(["/v1/tasks/task-running/stop"]);
  await expect(
    panel.getByRole("button", { name: "停止工单", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator('[data-area="delivery"]').click();
  await panel.getByRole("button", { name: /采购文件审核/ }).click();
  await expect(panel.locator(".fc-badge").first()).toHaveText("已验收");
  await expect(
    panel.getByRole("button", { name: "停止工单", exact: true }),
  ).toHaveCount(0);
});
test("删除全部版本用智能体标识，可刷新在用冲突，撤销失败后可重试，保留历史", async ({
  page,
}) => {
  const panel = page.locator(".live-inspector");
  await page.evaluate(() => {
    window.factoryLiveFixture.blockDeletion = true;
  });
  await page.locator('[data-area="line"]').click();
  await panel.getByRole("button", { name: /审计助理/ }).click();
  await panel
    .getByRole("button", { name: "删除智能体（全部版本）", exact: true })
    .click();
  const confirm = panel.getByRole("region", { name: "删除智能体确认" });
  await expect(confirm).toContainText("audit-assistant");
  await expect(confirm).toContainText("历史工单");
  await confirm.getByRole("button", { name: "取消" }).click();
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.filter((c) =>
        c.path?.endsWith("/delete"),
      ),
    ),
  ).toHaveLength(0);
  await panel
    .getByRole("button", { name: "删除智能体（全部版本）", exact: true })
    .click();
  await confirm.getByRole("button", { name: "确认删除全部版本" }).click();
  await expect(panel.getByRole("alert")).toContainText("task-running");
  await panel.getByRole("button", { name: "刷新智能体状态" }).click();
  await page.evaluate(() => {
    window.factoryLiveFixture.blockDeletion = false;
    window.factoryLiveFixture.revokeFails = true;
  });
  await confirm.getByRole("button", { name: "确认删除全部版本" }).click();
  await expect(panel.getByRole("alert")).toContainText("503");
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(
    panel.getByRole("button", { name: "重试删除智能体（全部版本）" }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.factoryLiveFixture.revokeFails = false;
  });
  await panel
    .getByRole("button", { name: "重试删除智能体（全部版本）" })
    .click();
  await confirm
    .getByRole("button", { name: "确认删除全部版本" })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect(
    panel.getByText(/已删除智能体 audit-assistant 的全部 2 个登记版本/),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "升级版本" })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls
        .filter((c) => c.path?.endsWith("/delete"))
        .map((c) => c.path),
    ),
  ).toEqual(Array(3).fill("/v1/factory/agents/audit-assistant/delete"));
  await panel.getByRole("button", { name: "返回上一级" }).click();
  await panel.getByLabel("版本状态").selectOption("");
  await expect(panel.getByText("没有符合条件的智能体版本")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-area="delivery"]').click();
  await expect(
    panel.getByRole("button", { name: /采购文件审核/ }),
  ).toBeVisible();
});

test("新建工单可混用本地附件与知识片段，补充需求在同一工单按原请求重试", async ({
  page,
}) => {
  const modal = page.getByRole("dialog"),
    panel = page.locator(".live-inspector");
  await page.getByRole("button", { name: /新建需求/ }).click();
  await modal.getByLabel("需求内容").fill("核对收货报告");
  await expect(modal.locator('input[type="file"]')).toHaveCount(0);
  const uploadBox = await modal
      .getByRole("button", { name: "上传本地文件" })
      .boundingBox(),
    basketBox = await modal
      .getByRole("button", { name: "从资料筐选择" })
      .boundingBox();
  expect(uploadBox).not.toBeNull();
  expect(basketBox).not.toBeNull();
  expect(
    Math.abs(
      uploadBox!.y +
        uploadBox!.height / 2 -
        basketBox!.y -
        basketBox!.height / 2,
    ),
  ).toBeLessThan(2);
  await modal.getByRole("button", { name: "上传本地文件" }).click();
  await expect(modal).toContainText("新增说明.txt");
  await modal.getByRole("button", { name: "从资料筐选择" }).click();
  await modal
    .getByRole("checkbox", { name: "选择筐中资料 实施目标片段.md" })
    .check();
  await modal.getByRole("button", { name: "提交并跟随" }).click();
  await expect(modal).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls.find(
          (c) => c.method === "POST" && c.path === "/v1/tasks",
        )?.body?.inputIds,
    ),
  ).toEqual(["local-upload", "basket-upload"]);
  await page.keyboard.press("Escape");
  await page.locator('[data-area="quality"]').click();
  await panel.getByRole("button", { name: /采购文件审核/ }).click();
  await panel.getByRole("button", { name: "补充需求", exact: true }).click();
  const submit = modal.getByRole("button", { name: "提交补充需求" });
  await expect(submit).toBeDisabled();
  await modal.getByLabel("补充要求").fill("请按新增的验收口径重算");
  await modal.getByRole("button", { name: "从资料筐选择" }).click();
  await modal
    .getByRole("checkbox", { name: "选择筐中资料 实施目标片段.md" })
    .check();
  await page.evaluate(() => {
    window.factoryLiveFixture.failNextAmend = true;
  });
  await submit.click();
  await expect(modal.getByRole("alert")).toBeVisible();
  await submit.click();
  await expect(modal).toHaveCount(0);
  const calls = await page.evaluate(() => window.factoryLiveFixture.calls);
  const reviews = calls.filter(
    (c) => c.path === "/v1/tasks/task-with-review/review",
  );
  expect(reviews).toHaveLength(2);
  expect(reviews[0].body).toMatchObject({
    decision: "amend",
    message: "请按新增的验收口径重算",
    inputIds: ["basket-upload"],
    reviewId: "round-real-9",
  });
  expect(reviews[0].idempotencyKey).toBeTruthy();
  expect(reviews[1].idempotencyKey).toBe(reviews[0].idempotencyKey);
  expect(
    calls.filter((c) => c.method === "factory_upload_basket_item"),
  ).toHaveLength(2);
});
test("人工可直接退回重制并附修改意见", async ({ page }) => {
  const panel = page.locator(".live-inspector");
  await page.locator('[data-area="quality"]').click();
  await panel.getByRole("button", { name: /采购文件审核/ }).click();
  await panel.getByRole("button", { name: "退回重制", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "退回重制" });
  await modal.getByLabel("重制意见（可选）").fill("把时间线移到交付首页");
  await modal.getByRole("button", { name: "确认退回重制" }).click();
  await expect(modal).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls.find((c) => c.path?.endsWith("/review"))
          ?.body,
    ),
  ).toMatchObject({
    decision: "revise",
    reviewId: "round-real-9",
    message: "把时间线移到交付首页",
    inputIds: [],
  });
});

test("工厂说明和运行时帮助可在桌面与窄屏阅读", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });

  await page.getByRole("button", { name: "工厂说明" }).click();
  const guide = page.getByRole("dialog", { name: "智能工厂说明" });
  await expect(guide.getByRole("heading", { name: "运行时" })).toBeVisible();
  await expect(guide).toContainText("本地服务运行时");
  await guide.getByRole("button", { name: "关闭窗口" }).click();

  await page.locator('[data-area="runtime"]').click();
  const panel = page.locator(".live-inspector");
  await expect(
    panel.locator(".live-list").first().getByText("Codex 推理运行时"),
  ).toBeVisible();
  const help = panel.getByRole("button", { name: "解释：运行时" });
  expect(
    await help.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        glyph: button.textContent,
        borderRadius: style.borderRadius,
        borderWidth: style.borderTopWidth,
      };
    }),
  ).toEqual({ glyph: "?", borderRadius: "5px", borderWidth: "0px" });
  await help.focus();
  await expect(panel.getByRole("tooltip")).toContainText("执行环境");
  await help.click();
  await panel.getByRole("button", { name: "筛选此环境" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("tooltip")).toHaveCount(0);
  await expect(panel).toBeVisible();

  await page.setViewportSize({ width: 412, height: 820 });
  await panel.getByRole("button", { name: "筛选此环境" }).focus();
  await help.focus();
  const mobileTooltip = panel.getByRole("tooltip");
  await expect(mobileTooltip).toBeVisible();
  const box = await mobileTooltip.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(412);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
