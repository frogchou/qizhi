import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installAssemblyFixture } from "./factory-assembly.fixture";
import { installOptimizationFixture } from "./factory-optimization.fixture";

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
  bytes?: number[];
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
  lineLoading?: boolean;
  lineError?: boolean;
  oldRuntimeApi?: boolean;
  lineCount?: number;
  idleVersion?: boolean;
  catalogCount?: number;
  readyCandidate?: boolean;
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
    assembly?: {
      draftId: string;
      candidateId: string;
      runId: string;
      packageDigest: string;
    };
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
      line: "1 个运行实例",
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
        runningInstances: 1,
        readyVersions: 1,
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
        ...(state.idleVersion
          ? [{ ...demoAgent, agentId: "indexer", displayName: "索引助理" }]
          : []),
        ...(state.release ? [state.release] : []),
        ...Array.from({ length: state.catalogCount ?? 0 }, (_, index) => ({
          agentId: "catalog-" + index,
          displayName: "资料核对 " + index,
          version: "4.2." + index,
          status:
            index === 0
              ? "self_check_failed"
              : index >= 180
                ? "offline"
                : "pending_review",
        })),
      ].map((a) => ({
        ...a,
        status:
          a.agentId === demoAgent.agentId && state.deleting
            ? "deleting"
            : a.status,
        id: a.agentId + "@" + a.version,
        runtime:
          a.agentId.startsWith("catalog-") &&
          Number(a.agentId.slice("catalog-".length)) % 2 === 0
            ? "native"
            : "codex",
        createdAt: now(),
        approvedAt: now(),
        runningCount:
          a.agentId === demoAgent.agentId &&
          a.version === demoAgent.version &&
          !state.stopped?.includes("task-running")
            ? 1
            : 0,
        capabilities: a.agentId.startsWith("catalog-")
          ? [{ name: "ledger.Review", description: "核对%_Review" }]
          : [{ name: "knowledge.retrieve", description: "检索机构档案" }],
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
      if (command === "factory_save_skill_file") {
        state.calls.push({ method: command, ...args });
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
        if (path.endsWith("/approve") && state.release) {
          state.release.status = "ready";
          return state.release;
        }
        if (path.endsWith("/offline") && state.release) {
          state.release.status = "offline";
          return state.release;
        }
      }
      if (path.endsWith("/overview")) {
        const runningInstances = state.stopped?.includes("task-running")
          ? 0
          : (state.lineCount ?? 1);
        const versions = agents();
        return {
          cursor: String(state.events.length),
          observedAt: now(),
          recentActivities: [event],
          areas: Object.fromEntries(
            Object.entries(names).map(([key, summary]) => [
              key,
              {
                count: key === "line" ? runningInstances : 1,
                summary:
                  key === "line" ? runningInstances + " 个运行实例" : summary,
                metrics:
                  key === "line"
                    ? {
                        ...areaMetrics.line,
                        runningInstances,
                        readyVersions: versions.filter(
                          (version) => version.status === "ready",
                        ).length,
                        pendingReviewVersions: versions.filter(
                          (version) => version.status === "pending_review",
                        ).length,
                      }
                    : areaMetrics[key as keyof typeof areaMetrics],
                ...(key === "assets" ? { connection } : {}),
              },
            ]),
          ),
        };
      }
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
      if (path === "/v1/factory/agents/audit-assistant/status")
        return {
          agentId: "audit-assistant",
          status: state.deleting ? "deleting" : "active",
          versionCount: 2,
        };
      if (path === "/v1/factory/agents") {
        const get = (key: string) => url.searchParams.get(key);
        const status = get("status");
        const search = get("search")?.trim().toLowerCase();
        const matches = agents().filter(
          (a) =>
            (!status ||
              (status === "working"
                ? a.runningCount > 0
                : a.status === status)) &&
            (!get("runtime") || a.runtime === get("runtime")) &&
            (!get("agentId") || a.agentId === get("agentId")) &&
            (!get("version") || a.version === get("version")) &&
            (!search ||
              [
                a.id,
                a.displayName,
                "v" + a.version,
                ...a.capabilities.flatMap((c) => [c.name, c.description]),
              ].some((field) => field.toLowerCase().includes(search))),
        );
        const limit = Number(get("limit") || 20);
        const offset = Number(get("offset") || 0);
        return {
          ...readPage(matches),
          limit,
          offset,
          items: matches.slice(offset, offset + limit),
        };
      }
      if (path === "/v1/factory/monitor") return readPage([event]);
      if (
        path === "/v1/factory/runtimes" &&
        url.searchParams.get("area") === "line" &&
        !state.oldRuntimeApi
      ) {
        if (url.searchParams.get("state") !== "active")
          throw Error("生产线应查询正在运行的实例");
        while (state.lineLoading)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (state.lineError) throw Error("运行实例暂时不可用");
        const count = state.stopped?.includes("task-running")
          ? 0
          : (state.lineCount ?? 1);
        const instances = Array.from({ length: count }, (_, index) => ({
          id: "attempt-" + index,
          instanceId: "worker-" + (42 + index),
          taskId: index % 2 ? "trial-order" : "task-running",
          goal: index % 2 ? "试跑五月报价" : "正在执行的资料检索",
          nodeKey: "retrieve",
          capability: "knowledge.retrieve",
          agentId: index % 2 ? "quote-desk" : "audit-assistant",
          displayName: index % 2 ? "报价核对" : "审计助理",
          agentVersion: index % 2 ? "2.0.0" : "1.0.0",
          state: index % 2 ? "stopping" : "leased",
          testRun: index % 2 === 1,
          lastHeartbeatAt: index % 2 ? null : now(),
          createdAt: now(),
        }));
        const limit = Number(url.searchParams.get("limit") || 20);
        const offset = Number(url.searchParams.get("offset") || 0);
        return {
          ...readPage(instances),
          limit,
          offset,
          items: instances.slice(offset, offset + limit),
        };
      }
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
async function openStudio(page: Page) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "智能体装配", exact: true })
    .click();
  return page.locator(".assembly-studio");
}
test.beforeEach(async ({ page }) => {
  await install(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByText("实时连接", { exact: false })).toBeVisible();
  await installAssemblyFixture(page);
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
  await expect(page.getByRole("tooltip")).toContainText("1 个运行实例");
  for (const [area, expected] of [
    ["intake", "所有渠道的需求"],
    ["control", "采购文件审核"],
    ["line", "实例 worker-42"],
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
test("导入 Skill 文件夹可核对相对路径，复制新版本保留附件并下载原字节", async ({
  page,
}, testInfo) => {
  const fixture = testInfo.outputPath("报价规则");
  await mkdir(join(fixture, "examples"), { recursive: true });
  await writeFile(join(fixture, "SKILL.md"), "# 比较报价");
  await writeFile(join(fixture, "examples", "币种.csv"), "currency\nCNY");
  await openStudio(page);
  await page.getByRole("button", { name: "智能体可调用资源管理" }).click();
  const library = page.getByRole("dialog", { name: "智能体可调用资源管理" });
  await library.getByRole("button", { name: "登记资源", exact: true }).click();
  await library.getByLabel("资源名称").fill("比价规则");
  await library.getByLabel("资源标识").fill("compare-quotes");
  await library.getByLabel("资源用途").fill("核对币种");
  await library.getByLabel("选择资料文件夹").setInputFiles(fixture);
  await expect(
    library.getByRole("textbox", { name: "Skill 正文", exact: true }),
  ).toHaveValue("# 比较报价");
  await expect(
    library.getByText("examples/币种.csv", { exact: true }),
  ).toBeVisible();
  await library.getByLabel("选择辅助文件").setInputFiles([
    {
      name: "table.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0, 1, 254]),
    },
    { name: "omit.txt", mimeType: "text/plain", buffer: Buffer.from("略") },
  ]);
  await library
    .getByRole("button", { name: "移除 omit.txt", exact: true })
    .click();
  await library.getByRole("button", { name: "保存资源版本" }).click();
  const row = library.getByRole("article").filter({ hasText: "比价规则" });
  await row.getByRole("button", { name: "查看版本内容" }).click();
  const detail = page.getByRole("dialog", { name: "资源版本内容" });
  await detail.getByRole("button", { name: "查看 examples/币种.csv" }).click();
  await expect(
    detail.locator("pre").filter({ hasText: "currency" }),
  ).toContainText("CNY");
  await page.screenshot({
    path: testInfo.outputPath("skill-package-files.png"),
  });
  await detail.getByRole("button", { name: "下载 table.bin" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.factoryLiveFixture.calls.find(
          (c) => c.method === "factory_save_skill_file",
        ),
      ),
    )
    .toMatchObject({ fileName: "table.bin", bytes: [0, 1, 254] });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(library).toBeVisible();
  await row.getByRole("button", { name: "登记新版本" }).click();
  await library.getByLabel("资源版本").fill("1.1.0");
  await library.getByRole("button", { name: "保存资源版本" }).click();
  const bodies = await page.evaluate(() =>
    window.factoryLiveFixture.calls
      .filter(
        (c) =>
          c.method === "POST" && c.path === "/v1/factory/assembly-resources",
      )
      .map((c) => c.body),
  );
  expect(bodies).toHaveLength(2);
  expect((bodies[1] as { files: unknown[] }).files).toEqual([
    { path: "examples/币种.csv", contentBase64: "Y3VycmVuY3kKQ05Z" },
    { path: "table.bin", contentBase64: "AAH+" },
  ]);
  expect(bodies[1]).toMatchObject({
    version: "1.1.0",
    content: "# 比较报价",
    files: [
      { path: "examples/币种.csv", contentBase64: "Y3VycmVuY3kKQ05Z" },
      { path: "table.bin", contentBase64: "AAH+" },
    ],
  });
});
test("装配编辑保留手工输入，明确选用建议与多个真实知识库", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (["warning", "error"].includes(entry.type())) errors.push(entry.text());
  });
  await page.setViewportSize({ width: 1280, height: 820 });
  const panel = await openStudio(page);
  await expect(
    panel.getByRole("heading", { name: "智能体基本信息" }),
  ).toBeVisible();
  await panel.getByLabel("智能体与版本").selectOption("quote-draft");
  await panel
    .getByRole("textbox", { name: "智能体职责", exact: true })
    .fill("保留人工调整的结算日期");
  await panel.getByRole("tab", { name: "智能体管理", exact: true }).click();
  const manager = panel.getByRole("tabpanel", { name: "智能体管理" });
  await expect(
    manager.getByRole("button", { name: /审计助理.*v1\.0\.0/ }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "智能体组装", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "智能体职责", exact: true }),
  ).toHaveValue("保留人工调整的结算日期");
  await expect(
    panel.getByRole("heading", { name: "资源与权限" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: /RAGFlow 知识库/ }).click();
  await panel.getByRole("button", { name: /精选 Skill/ }).click();
  await expect(
    panel.getByText("RAGFlow 已连接", { exact: false }),
  ).toBeVisible();
  const suggested = panel.getByRole("checkbox", { name: /报价规范/ });
  await expect(suggested).not.toBeChecked();
  await suggested.check();
  await panel.getByRole("checkbox", { name: /产品资料/ }).check();
  await panel.getByRole("checkbox", { name: /采购报价/ }).check();
  await panel.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls
            .filter((c) => c.path?.endsWith("/save"))
            .at(-1)?.body,
      ),
    )
    .toMatchObject({
      revision: 1,
      description: "核对五月生效的报价",
      config: {
        description: "保留人工调整的结算日期",
        skills: ["quote-rules@1.0.0"],
        datasetIds: ["products", "prices"],
        mcpTools: [],
      },
    });
  const log = panel.getByRole("log", { name: "装配对话" });
  const composer = panel.getByLabel("给装配助手的消息");
  const assemble = panel.getByRole("button", { name: "一键装配" });
  await composer.fill("核对供应商发来的两份有效报价");
  await assemble.click();
  await expect(log.getByText("核对供应商发来的两份有效报价")).toBeVisible();
  await expect(
    log.getByText("遇到同币种的两份有效报价，应选哪份？"),
  ).toBeVisible();
  await composer.fill("按最近生效日");
  await assemble.click();
  await expect(log.getByText("按最近生效日", { exact: true })).toBeVisible();
  const assembled = log.getByText(
    "《报价核对》v1.0.0 已生成，可以测试这个版本。",
  );
  await expect(assembled).toBeVisible();
  await expect(panel.getByLabel("业务流程与交付物")).toHaveValue(
    "比较两份报价，按最近生效日选用有效报价。",
  );
  await expect(panel.getByLabel("智能体职责")).toHaveValue(
    "保留人工调整的结算日期",
  );
  await expect(
    panel.getByRole("button", { name: /去测试此版本/ }),
  ).toBeVisible();
  await panel.getByRole("button", { name: /RAGFlow 知识库/ }).click();
  await panel.getByRole("button", { name: /精选 Skill/ }).click();
  const dismiss = page
    .getByRole("region", { name: "桌面提示" })
    .getByRole("button", { name: "关闭提示" });
  while (await dismiss.count()) await dismiss.last().click();
  for (const width of [1280, 412]) {
    await page.setViewportSize({ width, height: 820 });
    await panel.evaluate((el) => {
      el.scrollTop = 0;
      el.querySelector(".studio-configuration")!.scrollTop = 0;
    });
    const chat = (await panel.locator(".studio-brief").boundingBox())!;
    const basics = (await panel.locator(".studio-basics").boundingBox())!;
    const permissions = (await panel
      .locator(".studio-resources")
      .boundingBox())!;
    const submit = (await assemble.boundingBox())!;
    const mine = (await log
      .locator('[data-role="user"]')
      .last()
      .boundingBox())!;
    const theirs = (await log
      .locator('[data-role="assistant"]')
      .last()
      .boundingBox())!;
    expect(mine.x + mine.width).toBeGreaterThan(theirs.x + theirs.width);
    expect(permissions.y).toBeGreaterThanOrEqual(basics.y + basics.height - 1);
    expect(submit.y + submit.height).toBeLessThanOrEqual(820);
    if (width === 1280)
      expect(basics.x).toBeGreaterThanOrEqual(chat.x + chat.width);
    else expect(basics.y).toBeGreaterThanOrEqual(chat.y + chat.height);
    await expect(assembled).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("assembly-dialogue-" + width + ".png"),
    });
  }
  await log.getByRole("button", { name: /测试此版本/ }).click();
  await expect(panel.getByLabel("生成记录", { exact: true })).toHaveValue(
    "auto-build-2",
  );
  expect(errors).toEqual([]);
});
test("三页签保留未提交内容，并把指定生成记录交给测试", async ({
  page,
}, testInfo) => {
  const studio = await openStudio(page);
  const nav = studio.getByRole("tablist", { name: "智能体装配导航" });
  const editor = nav.getByRole("tab", { name: "智能体组装" });
  const tests = nav.getByRole("tab", { name: "智能体测试" });
  const management = nav.getByRole("tab", { name: "智能体管理" });
  await expect(nav.getByRole("tab")).toHaveText([
    "智能体管理",
    "智能体组装",
    "智能体测试",
  ]);
  await expect(editor).toHaveAttribute("aria-selected", "true");
  await studio.getByLabel("智能体与版本").selectOption("quote-draft");
  const groups = studio.locator(".studio-resource-toggle");
  await expect(groups).toHaveCount(4);
  await expect(
    studio.locator('.studio-resource-toggle[aria-expanded="true"]'),
  ).toHaveCount(0);
  await expect(studio.getByRole("textbox", { name: "样例需求" })).toHaveCount(
    0,
  );
  const tools = studio.getByRole("button", { name: /MCP 工具/ });
  await tools.click();
  await studio.getByRole("checkbox", { name: /发送通知/ }).check();
  await tools.click();
  await expect(tools).toContainText("发送通知");
  await expect(tools).toContainText("对外写入");
  await tools.click();
  await studio.getByRole("checkbox", { name: /发送通知/ }).uncheck();
  await tools.click();
  await expect(studio.getByText("修改已保存", { exact: true })).toBeVisible();
  await studio
    .getByRole("textbox", { name: "智能体职责", exact: true })
    .fill("下次生成时增加审批步骤");
  await editor.focus();
  await page.keyboard.press("End");
  await expect(tests).toBeFocused();
  await expect(studio.getByRole("heading", { name: "资源与权限" })).toHaveCount(
    0,
  );
  const record = studio.getByLabel("生成记录", { exact: true });
  await record.selectOption("sealed-older");
  await studio.getByLabel("样例需求").fill("只测试选中的旧记录");
  await tests.focus();
  await page.keyboard.press("Home");
  await expect(management).toBeFocused();
  await expect(
    studio.getByRole("button", { name: "组装新智能体" }),
  ).toBeVisible();
  await tests.click();
  await expect(record).toHaveValue("sealed-older");
  await expect(studio.getByLabel("样例需求")).toHaveValue("只测试选中的旧记录");
  await editor.click();
  await expect(
    studio.getByRole("textbox", { name: "智能体职责", exact: true }),
  ).toHaveValue("下次生成时增加审批步骤");
  await studio.getByRole("button", { name: /测试上次生成/ }).click();
  await expect(tests).toHaveAttribute("aria-selected", "true");
  await expect(record).toHaveValue("sealed-one");
  await expect(studio.getByLabel("样例需求")).toHaveValue("");
  await page.screenshot({ path: testInfo.outputPath("testing.png") });
});
test("从管理页升级独立程序包，回显所选历史版本并提交新版本审核", async ({
  page,
}) => {
  const studio = await openStudio(page);
  const manage = studio.getByRole("tab", { name: "智能体管理", exact: true });
  const assemble = studio.getByRole("tab", { name: "智能体组装", exact: true });
  await manage.click();
  await expect(studio.getByText(/已保存的组装/)).toHaveCount(0);
  await studio.getByRole("button", { name: /审计助理.*v0\.9\.0/ }).click();
  await studio.getByRole("button", { name: "升级智能体" }).click();
  await expect(assemble).toHaveAttribute("aria-selected", "true");
  const editor = studio.getByRole("tabpanel", { name: "智能体组装" });
  await expect(editor.getByLabel("智能体名称")).toHaveValue("审计助理旧版");
  await expect(editor.getByLabel("目标发布版本")).toHaveValue("1.0.1");
  await expect(editor.getByLabel("knowledge.retrieve 能力说明")).toHaveValue(
    "按旧版规则查询档案",
  );
  await editor.getByLabel("智能体名称").fill("机构档案审计");
  await editor
    .getByLabel("knowledge.retrieve 能力说明")
    .fill("核对机构档案中的审核资料");
  await manage.click();
  await assemble.click();
  await expect(editor.getByLabel("智能体名称")).toHaveValue("机构档案审计");
  await editor.getByRole("button", { name: "发布新版本" }).click();
  await expect(manage).toHaveAttribute("aria-selected", "true");
  await expect(
    studio.getByRole("heading", { name: "机构档案审计" }),
  ).toBeVisible();
  const payload = await page.evaluate(
    () =>
      window.factoryLiveFixture.calls.find(
        (c) =>
          c.path === "/v1/factory/releases" && c.body?.baseVersion === "0.9.0",
      )?.body,
  );
  expect(payload).toMatchObject({
    intent: "upgrade",
    baseVersion: "0.9.0",
    agentId: "audit-assistant",
    version: "1.0.1",
    displayName: "机构档案审计",
    capabilities: [
      { name: "knowledge.retrieve", description: "核对机构档案中的审核资料" },
    ],
  });
});
test("用指定生成版本和附件测试，答复后人工认可并按同一快照发布", async ({
  page,
}, testInfo) => {
  const panel = await openStudio(page);
  await panel.getByLabel("智能体与版本").selectOption("quote-draft");
  await panel.getByRole("tab", { name: "智能体测试" }).click();
  await panel
    .getByLabel("生成记录", { exact: true })
    .selectOption("sealed-one");
  await panel.getByRole("button", { name: "查看源码与差异" }).click();
  const source = page.getByRole("dialog", { name: "生成源码与差异" });
  await expect(source).toContainText("return amount * rate;");
  await source.getByRole("button", { name: "版本差异" }).click();
  await expect(source).toContainText("return amount;");
  await source.getByRole("button", { name: "关闭窗口" }).click();
  await panel.getByLabel("样例需求").fill("试跑五月报价");
  await panel.getByRole("button", { name: "上传本地文件" }).click();
  await panel.getByRole("button", { name: "测试智能体" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find(
            (c) => c.path?.endsWith("/runs") && c.method === "POST",
          )?.body,
      ),
    )
    .toMatchObject({
      candidateId: "sealed-one",
      inputIds: ["local-upload"],
      goal: "试跑五月报价",
    });
  await panel.getByRole("button", { name: /打开测试工单/ }).click();
  const inspector = page.locator(".live-inspector");
  await inspector.getByLabel("currency").fill("CNY");
  await inspector.getByRole("button", { name: "提交答复并继续" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find((c) =>
            c.path?.endsWith("/respond"),
          )?.body,
      ),
    )
    .toMatchObject({ response: { currency: "CNY" } });
  await inspector.getByRole("button", { name: "交付成果" }).click();
  const artifact = inspector.getByRole("button", { name: "下载 核对结果.txt" });
  await artifact.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find(
            (c) => c.method === "DOWNLOAD" && c.taskId === "trial-order",
          )?.artifactId,
      ),
    )
    .toBe("actual-artifact");
  await artifact.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("trial-delivery.png") });
  await openStudio(page);
  await expect(panel.getByText("生效日边界", { exact: false })).toBeVisible();
  await panel.getByText("测试工具回执", { exact: true }).click();
  await expect(
    panel.getByText("preview-adapter", { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("验收意见（可选）").fill("已核对报价差异和预览回执。");
  await panel.getByRole("button", { name: "认可测试结果" }).click();
  await expect(page.getByRole("region", { name: "桌面提示" })).toContainText(
    "必需项待人工核实",
  );
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.some((c) => c.path?.endsWith("/accept")),
    ),
  ).toBe(false);
  await panel.getByRole("button", { name: "去工单人工复核" }).click();
  await expect(inspector.getByText("第 1 轮等待决定")).toBeVisible();
  await inspector
    .getByRole("button", { name: "确认验收", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find(
            (c) => c.path === "/v1/tasks/trial-order/review",
          )?.body,
      ),
    )
    .toMatchObject({ decision: "accept", reviewId: "quote-review" });
  await openStudio(page);
  await panel.getByRole("button", { name: "刷新测试记录" }).click();
  await expect(panel.getByText(/工单第 1 轮已由人工验收通过/)).toBeVisible();
  await expect(panel.getByLabel("验收意见（可选）")).toHaveValue(
    "已核对报价差异和预览回执。",
  );
  await panel
    .getByRole("button", { name: "认可测试结果" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("trial-human-review.png"),
  });
  await panel.getByRole("button", { name: "提交发布审核" }).click();
  await expect(page.getByRole("region", { name: "桌面提示" })).toContainText(
    "请先认可这份测试结果",
  );
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.some((c) => c.path?.endsWith("/publish")),
    ),
  ).toBe(false);
  await panel.getByRole("button", { name: "认可测试结果" }).click();
  await expect(panel.getByText("用户已认可", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find((c) =>
            c.path?.endsWith("/accept"),
          )?.body,
      ),
    )
    .toMatchObject({
      candidateId: "sealed-one",
      reviewId: "quote-review",
      feedback: "已核对报价差异和预览回执。",
    });
  await panel.getByRole("button", { name: "提交发布审核" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find((c) =>
            c.path?.endsWith("/publish"),
          )?.body,
      ),
    )
    .toMatchObject({ candidateId: "sealed-one", runId: "run-one" });
  await panel.getByRole("button", { name: "管理此版本" }).click();
  const managed = panel.getByRole("tabpanel", { name: "智能体管理" });
  await expect(
    managed.getByRole("heading", { name: "发布依据" }),
  ).toBeVisible();
  await managed.getByRole("button", { name: "打开版本测试" }).click();
  await expect(panel.getByRole("tab", { name: "智能体测试" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByLabel("生成记录", { exact: true })).toHaveValue(
    "sealed-one",
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "智能工厂" })
    .click();
  await page.locator('[data-area="line"]').click();
  await inspector.getByRole("tab", { name: "待审核" }).click();
  await inspector.getByRole("button", { name: /报价核对.*v1\.0\.0/ }).click();
  await expect(
    inspector.getByRole("heading", { name: "发布依据" }),
  ).toBeVisible();
  await expect(inspector.getByText("样例已获用户认可")).toBeVisible();
  await inspector.getByRole("button", { name: "升级智能体" }).click();
  await expect(panel.getByLabel("智能体与版本")).toHaveValue("derived-draft");
  await expect(panel.getByLabel("目标发布版本")).toHaveValue("1.0.1");
  expect(
    await page.evaluate(
      () =>
        window.factoryLiveFixture.calls
          .filter(
            (c) => c.path === "/v1/factory/assemblies" && c.method === "POST",
          )
          .at(-1)?.body?.baseRelease,
    ),
  ).toEqual({ agentId: "quote-desk", version: "1.0.0" });
});
test("根据反馈优化失败测试，保护手改配置和样例，按真实进度测试新生成的候选", async ({
  page,
}, testInfo) => {
  test.setTimeout(45000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (["error", "warning"].includes(e.type())) errors.push(e.text());
  });
  await installOptimizationFixture(page, "failed");
  const studio = await openStudio(page);
  const assembly = studio.getByRole("tab", { name: "智能体组装", exact: true });
  const tests = studio.getByRole("tab", { name: "智能体测试" });
  await studio.getByLabel("智能体与版本").selectOption("quote-draft");
  const duty = studio.getByRole("textbox", { name: "智能体职责", exact: true });
  await expect(duty).toHaveValue("按币种和生效日核对");
  const original = await duty.inputValue();
  await duty.fill("我正在修改的职责");
  await tests.click();
  await studio.getByLabel("选择测试记录").selectOption("bound-run");
  await studio.getByLabel("样例需求").fill("尚未提交的新样例");
  await studio.getByText("结构化样例（可选）", { exact: true }).click();
  await studio.getByLabel("输入 JSON").fill('{"currency":"USD"}');
  await studio.getByRole("button", { name: "上传本地文件" }).click();
  await expect(
    studio.getByText("新增说明.txt", { exact: false }),
  ).toBeVisible();
  const optimize = studio.getByRole("button", { name: "根据反馈优化" });
  await optimize.click();
  await expect(page.getByRole("region", { name: "桌面提示" })).toContainText(
    "有未保存的修改",
  );
  await studio.getByRole("button", { name: "查看未保存的修改" }).click();
  await expect(duty).toHaveValue("我正在修改的职责");
  await duty.fill(original);
  await tests.click();
  await expect(studio.getByLabel("验收意见（可选）")).toHaveValue("");
  await page.evaluate(() => {
    window.optimizationFixture.response = "hold";
  });
  await optimize.dblclick();
  await expect(optimize).toBeDisabled();
  await expect(tests).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.filter((c) =>
            c.path?.endsWith("/optimize"),
          ).length,
      ),
    )
    .toBe(1);
  const [request] = await page.evaluate(() =>
    window.factoryLiveFixture.calls.filter((c) =>
      c.path?.endsWith("/optimize"),
    ),
  );
  expect(request).toMatchObject({
    method: "POST",
    path: "/v1/factory/assemblies/quote-draft/runs/bound-run/optimize",
    body: {
      candidateId: "sealed-one",
      packageDigest: "a".repeat(64),
      revision: 1,
      feedback: "",
      reviewId: null,
      requestId: expect.any(String),
    },
  });
  await page.evaluate(() => window.optimizationFixture.acknowledge());
  await expect(assembly).toHaveAttribute("aria-selected", "true");
  const progress = studio.getByRole("region", { name: "反馈优化进度" });
  await expect(progress).toContainText("反馈优化已排队");
  await expect(
    progress.getByRole("button", { name: "测试优化后的版本" }),
  ).toHaveCount(0);
  await progress.getByRole("button", { name: "返回原测试" }).click();
  await expect(optimize).toBeDisabled();
  await expect(studio.getByLabel("选择测试记录")).toHaveValue("bound-run");
  await studio.getByRole("button", { name: "查看优化进度" }).click();
  await page.evaluate(() => window.optimizationFixture.advance("running"));
  await expect(progress).toContainText("正在校验优化后的包和固定用例", {
    timeout: 10000,
  });
  for (const width of [1280, 412]) {
    await page.setViewportSize({ width, height: 840 });
    await expect(page).toHaveTitle(/栖知|qizhi/i);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("optimization-running-" + width + ".png"),
    });
  }
  await page.evaluate(() => window.optimizationFixture.advance("completed"));
  const retest = progress.getByRole("button", { name: "测试优化后的版本" });
  await expect(retest).toBeVisible({ timeout: 10000 });
  await retest.click();
  await expect(studio.getByLabel("生成记录", { exact: true })).toHaveValue(
    "optimization-1",
  );
  await expect(studio.getByLabel("样例需求")).toHaveValue("");
  await assembly.click();
  await progress.getByRole("button", { name: "返回原测试" }).click();
  await expect(studio.getByLabel("样例需求")).toHaveValue("尚未提交的新样例");
  await expect(
    studio.getByText("新增说明.txt", { exact: false }),
  ).toBeVisible();
  await studio.getByText("结构化样例（可选）", { exact: true }).click();
  await expect(studio.getByLabel("输入 JSON")).toHaveValue(
    '{"currency":"USD"}',
  );
  await expect(
    studio.getByText("汇率缺失时输出错误", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("根据反馈优化已归档来源的上线版本，保留认可意见，失败可重试并进入独立升级草稿", async ({
  page,
}, testInfo) => {
  test.setTimeout(45000);
  await installOptimizationFixture(page, "published");
  const studio = await openStudio(page);
  const assembly = studio.getByRole("tab", { name: "智能体组装", exact: true });
  const workInProgress = studio.getByRole("textbox", {
    name: "给装配助手的消息",
  });
  await workInProgress.fill("正在起草另一项装配委托");
  await studio.getByRole("tab", { name: "智能体管理" }).click();
  await studio.getByRole("button", { name: /正式报价核对.*v1\.0\.0/ }).click();
  await expect(studio.getByRole("heading", { name: "发布依据" })).toBeVisible();
  await studio.getByRole("button", { name: "打开版本测试" }).click();
  await expect(studio.getByLabel("选择测试记录")).toHaveValue("bound-run");
  await expect(
    studio.getByText("验收意见 · 原版报价已逐项核对", { exact: true }),
  ).toBeVisible();
  const optimize = studio.getByRole("button", { name: "根据反馈优化" });
  const opinion = studio.getByRole("textbox", { name: "优化意见" });
  await optimize.click();
  await expect(opinion).toBeFocused();
  await expect(page.getByRole("region", { name: "桌面提示" })).toContainText(
    "请填写希望改进的内容",
  );
  await opinion.fill("按币种分组，再列出换算依据");
  await studio.getByLabel("样例需求").fill("保留到稍后再测的样例");
  await opinion.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("published-feedback.png"),
  });
  const reqs = () =>
    page.evaluate(() =>
      window.factoryLiveFixture.calls
        .filter((c) => c.path?.endsWith("/optimize"))
        .map((c) => c.body!),
    );
  for (const mode of ["invalid", "error"] as const) {
    await page.evaluate((mode) => {
      window.optimizationFixture.response = mode;
    }, mode);
    await optimize.click();
    await expect(page.getByRole("alert")).toContainText(
      mode === "invalid" ? "有效的优化回执" : "中台连接中断",
    );
    await expect(
      studio.getByRole("tab", { name: "智能体测试" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(opinion).toHaveValue("按币种分组，再列出换算依据");
  }
  await page.evaluate(() => {
    window.optimizationFixture.response = "ok";
  });
  await optimize.click();
  const draft = studio.getByLabel("智能体与版本");
  await expect(draft).toHaveValue("upgrade-1");
  await expect(studio.getByLabel("目标发布版本")).toHaveValue("1.0.1");
  const sent = await reqs();
  expect(sent).toHaveLength(3);
  expect(new Set(sent.map((body) => body.requestId)).size).toBe(1);
  expect(sent[0]).toMatchObject({
    candidateId: "sealed-one",
    packageDigest: "a".repeat(64),
    feedback: "按币种分组，再列出换算依据",
    reviewId: "bound-review",
    revision: 1,
  });
  const progress = studio.getByRole("region", { name: "反馈优化进度" });
  await expect(progress).toContainText("反馈优化已排队");
  await page.evaluate(() => window.optimizationFixture.advance("failed"));
  await expect(progress).toContainText("本次优化生成失败", { timeout: 10000 });
  await expect(page.getByRole("alert")).toContainText(
    "本轮生成未通过固定用例校验",
  );
  await progress.getByRole("button", { name: "返回原测试" }).click();
  await expect(draft).toHaveValue("quote-draft");
  await expect(opinion).toHaveValue("按币种分组，再列出换算依据");
  await expect(studio.getByLabel("样例需求")).toHaveValue(
    "保留到稍后再测的样例",
  );
  await expect(
    studio.getByText("验收意见 · 原版报价已逐项核对", { exact: true }),
  ).toBeVisible();
  await optimize.click();
  await expect(draft).toHaveValue("upgrade-2");
  const retried = await reqs();
  expect(retried[3].requestId).not.toBe(retried[0].requestId);
  await page.evaluate(() => window.optimizationFixture.advance("completed"));
  const retest = progress.getByRole("button", { name: "测试优化后的版本" });
  await expect(retest).toBeVisible({ timeout: 10000 });
  await retest.click();
  await expect(studio.getByLabel("生成记录", { exact: true })).toHaveValue(
    "optimization-2",
  );
  await assembly.click();
  await draft.selectOption("");
  await expect(workInProgress).toHaveValue("正在起草另一项装配委托");
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.filter(
        (c) => c.path?.endsWith("/publish") || c.path?.endsWith("/accept"),
      ),
    ),
  ).toEqual([]);
});

test("根据反馈优化保护无已发布候选的归档组装", async ({ page }) => {
  await installOptimizationFixture(page, "archived");
  await page.evaluate(() =>
    localStorage.setItem(
      "qizhi.factory.assembly.http://127.0.0.1:3010",
      "quote-draft",
    ),
  );
  const studio = await openStudio(page);
  await studio.getByRole("tab", { name: "智能体测试" }).click();
  await studio.getByLabel("选择测试记录").selectOption("bound-run");
  await studio.getByRole("button", { name: "根据反馈优化" }).click();
  await expect(page.getByRole("region", { name: "桌面提示" })).toContainText(
    "这份组装记录已归档",
  );
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls.filter((c) =>
        c.path?.endsWith("/optimize"),
      ),
    ),
  ).toEqual([]);
});

test("从已上线版本新建正式工单，带入主能力和知识库并保留写入授权选择", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.factoryLiveFixture.readyCandidate = true;
  });
  const panel = await openStudio(page);
  await panel.getByLabel("智能体与版本").selectOption("quote-draft");
  await panel.getByRole("tab", { name: "智能体测试" }).click();
  await panel
    .getByLabel("生成记录", { exact: true })
    .selectOption("sealed-one");
  await panel.getByRole("button", { name: "用此版本新建需求" }).click();
  const form = page.getByRole("dialog", { name: "新建需求" });
  await expect(
    form.getByRole("checkbox", { name: /正式报价核对/ }),
  ).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /检索资料/ })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /产品资料/ })).toBeChecked();
  await expect(
    form.getByRole("checkbox", { name: /发送通知/ }),
  ).not.toBeChecked();
  await form.getByLabel("需求内容").fill("核对七月报价");
  await form.getByRole("button", { name: "提交并跟随" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find(
            (c) => c.path === "/v1/tasks" && c.method === "POST",
          )?.body,
      ),
    )
    .toMatchObject({
      authorizedCapabilities: [
        "enterprise.quote.reconcile",
        "knowledge.retrieve",
      ],
      authorizedDatasetIds: ["products"],
      authorizedMcpTools: [],
    });
});
test("正式工单只有勾选后才授权外部效果，并记录目的地", async ({ page }) => {
  await page.getByRole("button", { name: /新建需求/ }).click();
  const form = page.getByRole("dialog", { name: "新建需求" });
  await form.getByLabel("需求内容").fill("核对报价并发给采购");
  await form.getByText("本次任务授权", { exact: true }).click();
  await form.getByRole("checkbox", { name: "明确指定本次授权" }).check();
  await form.getByRole("checkbox", { name: /发送通知/ }).check();
  await form.getByRole("checkbox", { name: /采购报价/ }).check();
  await expect(form.getByRole("button", { name: "提交并跟随" })).toBeDisabled();
  await form.getByLabel("对外写入的目的地或接收方").fill("采购一组");
  await form.getByRole("button", { name: "提交并跟随" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find(
            (c) => c.path === "/v1/tasks" && c.method === "POST",
          )?.body,
      ),
    )
    .toMatchObject({
      goal: expect.stringContaining("采购一组"),
      authorizedMcpTools: ["send@1.0.0"],
      authorizedDatasetIds: ["prices"],
    });
});
test("中台重连带来新修订时，合并保留人工改动及服务器新字段", async ({
  page,
}) => {
  const panel = await openStudio(page);
  await panel.getByLabel("智能体与版本").selectOption("quote-draft");
  await panel
    .getByRole("textbox", { name: "智能体职责", exact: true })
    .fill("人工增加月底核验");
  await page.evaluate(() => {
    window.factoryLiveFixture.disconnect = true;
  });
  await expect(
    page.getByRole("region", { name: "桌面提示" }).getByText(/中台连接已中断/),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "保存修改" })).toBeDisabled();
  await page.evaluate(() => {
    (
      window as unknown as { amendFactoryDraft: () => void }
    ).amendFactoryDraft();
    window.factoryLiveFixture.disconnect = false;
  });
  await panel.getByRole("button", { name: "合并我的改动" }).click();
  await panel.getByRole("button", { name: "保存修改" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.factoryLiveFixture.calls.find((c) => c.path?.endsWith("/save"))
            ?.body,
      ),
    )
    .toMatchObject({
      revision: 2,
      description: "核对五月生效的报价",
      config: { description: "人工增加月底核验", workflow: "中台新增汇率校验" },
    });
});
test("版本目录在全库搜索并保留筛选、页码和返回位置", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  await page.evaluate(() => {
    window.factoryLiveFixture.catalogCount = 320;
  });
  const studio = await openStudio(page);
  await studio.getByRole("tab", { name: "智能体管理" }).click();
  const manager = studio.getByRole("tabpanel", { name: "智能体管理" });
  const tabs = manager.getByRole("tablist", { name: "版本状态" });
  const all = tabs.getByRole("tab", { name: "全部版本" });
  const ready = tabs.getByRole("tab", { name: "已上线" });
  const offline = tabs.getByRole("tab", { name: "已下线" });
  const deleting = tabs.getByRole("tab", { name: "删除中" });
  const search = manager.getByRole("searchbox", { name: "搜索智能体版本" });
  const runtime = manager.getByRole("combobox", { name: "运行环境" });
  await expect(manager.getByText("共 322 个版本")).toBeVisible();
  for (const [name, label, tone] of [
    [/v1\.0\.0\b/, "已上线", "green"],
    [/v0\.9\.0\b/, "已下线", "orange"],
    [/v4\.2\.1\b/, "待审核", "amber"],
    [/v4\.2\.0\b/, "自检失败", "red"],
  ] as const) {
    const pill = manager
      .getByRole("button", { name })
      .getByText(label, { exact: true });
    await expect(pill).toBeVisible();
    const [red, green, blue] = await pill.evaluate((el) =>
      getComputedStyle(el).color.match(/\d+/g)!.map(Number),
    );
    if (tone === "green") expect(green).toBeGreaterThan(Math.max(red, blue));
    else if (tone === "amber" || tone === "orange") {
      expect(red).toBeGreaterThan(green);
      expect(green).toBeGreaterThan(blue);
      const hue = (60 * (green - blue)) / (red - blue);
      if (tone === "amber") expect(hue).toBeGreaterThan(36);
      else expect(hue).toBeLessThan(30);
    } else expect(red).toBeGreaterThan(Math.max(green, blue) * 2);
  }
  await all.focus();
  await all.press("ArrowRight");
  await expect(ready).toBeFocused();
  await expect(ready).toHaveAttribute("aria-selected", "true");
  await ready.press("End");
  await expect(deleting).toBeFocused();
  await deleting.press("Home");
  await expect(all).toBeFocused();
  await search.fill("核对%_reVIew");
  await expect(manager.getByText("共 320 个版本")).toBeVisible();
  await offline.click();
  await runtime.selectOption("native");
  await expect(manager.getByText("共 70 个版本")).toBeVisible();
  for (const width of [1280, 412]) {
    await page.setViewportSize({ width, height: 820 });
    expect(
      await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await expect(offline).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("version-catalog-" + width + ".png"),
    });
  }
  await manager.getByRole("button", { name: "下一页" }).click();
  await expect(manager.getByText("21–40 / 70")).toBeVisible();
  const row = manager.getByRole("button", { name: /v4\.2\.258\b/ });
  await row.scrollIntoViewIfNeeded();
  const top = await studio.evaluate((el) => el.scrollTop);
  await row.click();
  await expect(
    manager.getByRole("heading", { name: "资料核对 258" }),
  ).toBeVisible();
  await manager.getByRole("button", { name: "返回版本列表" }).click();
  await expect(search).toHaveValue("核对%_reVIew");
  await expect(runtime).toHaveValue("native");
  await expect(offline).toHaveAttribute("aria-selected", "true");
  await expect(manager.getByText("21–40 / 70")).toBeVisible();
  await expect(row).toBeFocused();
  await expect
    .poll(() => studio.evaluate((el) => el.scrollTop))
    .toBeCloseTo(top, 0);
  await search.fill("没有这种能力");
  await expect(manager.getByText("没有符合条件的智能体版本")).toBeVisible();
  await manager.getByRole("button", { name: "重置筛选" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(runtime).toHaveValue("");
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(manager.getByText("1–20 / 322")).toBeVisible();
  expect(errors).toEqual([]);
});

test("资源登记与下架使用精确版本，删除一个智能体版本保留另一版", async ({
  page,
}) => {
  const panel = await openStudio(page);
  await panel.getByRole("button", { name: "智能体可调用资源管理" }).click();
  const library = page.getByRole("dialog", { name: "智能体可调用资源管理" });
  await library.getByRole("button", { name: "登记资源", exact: true }).click();
  await library.getByLabel("资源名称").fill("税率规范");
  await library.getByLabel("资源标识").fill("tax-rules");
  await library.getByLabel("资源用途").fill("校验税率");
  await library.getByLabel("Skill 正文", { exact: true }).fill("# 核对税率");
  await library.getByRole("button", { name: "保存资源版本" }).click();
  const row = library.getByRole("article").filter({ hasText: "税率规范" });
  await row.getByRole("button", { name: "下架" }).click();
  await library.getByRole("button", { name: "确认变更" }).click();
  await expect(row).toContainText("已下架");
  await row.getByRole("button", { name: "登记新版本" }).click();
  await expect(
    library.getByRole("textbox", { name: "Skill 正文", exact: true }),
  ).toHaveValue("# 核对税率");
  await library.getByLabel("资源版本").fill("1.1.0");
  await library
    .getByRole("textbox", { name: "Skill 正文", exact: true })
    .fill("# 按生效日核对税率");
  await library.getByRole("button", { name: "保存资源版本" }).click();
  await expect(row).toHaveCount(2);
  await library.getByRole("button", { name: "关闭窗口" }).click();
  await panel.getByRole("tab", { name: "智能体管理" }).click();
  const manager = panel.getByRole("tabpanel", { name: "智能体管理" });
  await manager.getByRole("tab", { name: "全部版本" }).click();
  await manager.getByRole("button", { name: /v0.9.0/ }).click();
  await manager
    .getByRole("button", { name: "删除此版本", exact: true })
    .click();
  await manager
    .getByRole("button", { name: "确认删除此版本", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "桌面提示" })
      .getByText(/已删除 audit-assistant v0.9.0/),
  ).toBeVisible();
  await manager.getByRole("button", { name: "返回版本列表" }).click();
  await expect(manager.getByRole("tab", { name: "全部版本" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(manager.getByRole("button", { name: /v1.0.0/ })).toBeVisible();
  await expect(manager.getByRole("button", { name: /v0.9.0/ })).toHaveCount(0);
});
test("桌面与窄屏的装配页可选资源并切换到版本管理", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (entry) => {
    if (["error", "warning"].includes(entry.type())) errors.push(entry.text());
  });
  await page.setViewportSize({ width: 1280, height: 820 });
  const panel = await openStudio(page);
  await panel.getByLabel("智能体与版本").selectOption("quote-draft");
  await expect(
    panel.getByRole("heading", { name: "资源与权限" }),
  ).toBeVisible();
  const datasetGroup = panel.getByRole("button", { name: /RAGFlow 知识库/ });
  await expect(datasetGroup).toHaveAttribute("aria-expanded", "false");
  await datasetGroup.click();
  await expect(panel.getByRole("checkbox", { name: /采购报价/ })).toBeVisible();
  for (const width of [1280, 412]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page).toHaveTitle(/栖知|qizhi/i);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(panel.getByRole("tab", { name: "智能体管理" })).toBeVisible();
    await panel.getByRole("checkbox", { name: /采购报价/ }).check();
    await panel.getByRole("checkbox", { name: /产品资料/ }).check();
    await expect(
      panel.getByRole("checkbox", { name: /采购报价/ }),
    ).toBeChecked();
    if (width === 1280)
      await panel.evaluate((el) => {
        el.scrollTop = 0;
      });
    else
      await panel
        .getByRole("checkbox", { name: /采购报价/ })
        .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("assembly-selection-" + width + ".png"),
    });
    await panel.getByRole("tab", { name: "智能体管理" }).click();
    const manager = panel.getByRole("tabpanel", { name: "智能体管理" });
    await expect(
      manager.getByRole("button", { name: /审计助理.*v1\.0\.0/ }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("version-manager-" + width + ".png"),
    });
    await panel.getByRole("tab", { name: "智能体组装", exact: true }).click();
    await expect(
      panel.getByRole("checkbox", { name: /采购报价/ }),
    ).toBeChecked();
    await panel.evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  expect(errors).toEqual([]);
});
test("处理连接设置后继续未发送的装配消息", async ({ page }) => {
  const panel = await openStudio(page);
  await panel.getByLabel("智能体与版本").selectOption("quote-draft");
  await panel
    .getByRole("textbox", { name: "给装配助手的消息", exact: true })
    .fill("继续在原草稿编辑的业务规则");
  await panel.getByRole("button", { name: "连接设置" }).click();
  await openStudio(page);
  await expect(
    panel.getByRole("textbox", { name: "给装配助手的消息", exact: true }),
  ).toHaveValue("继续在原草稿编辑的业务规则");
});
test("从新委托生成时保护重复请求并能停止服务端操作", async ({ page }) => {
  const panel = await openStudio(page);
  await panel
    .getByRole("textbox", { name: "给装配助手的消息", exact: true })
    .fill("生成供应商报价核对流程");
  await panel.getByRole("button", { name: "一键装配" }).click();
  await expect(panel.getByText(/两份有效报价/)).toBeVisible();
  await panel.getByLabel("给装配助手的消息").fill("按最近生效日");
  await panel.getByRole("button", { name: "一键装配" }).click();
  await expect(
    panel.getByRole("log").getByText(/确认是否使用报价规范/),
  ).toBeVisible();
  const skills = panel.getByRole("button", { name: /精选 Skill/ });
  await expect(skills).toContainText("1 项建议");
  await skills.click();
  await expect(
    panel.getByRole("checkbox", { name: /报价规范/ }),
  ).not.toBeChecked();
  await skills.click();
  const generate = panel.getByRole("button", { name: "生成智能体" });
  await generate.click();
  await expect(
    page.getByRole("region", { name: "桌面提示" }).getByRole("alert"),
  ).toContainText("请重试");
  await generate.click();
  await expect(panel.getByText("校验候选源码")).toBeVisible();
  await panel.getByRole("button", { name: "停止操作" }).click();
  await expect(panel.getByText("用户已停止操作")).toBeVisible();
  const requests = await page.evaluate(() =>
    window.factoryLiveFixture.calls
      .filter((c) => c.path?.endsWith("/generate"))
      .map((c) => c.body),
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]?.requestId).toBeTruthy();
  expect(requests[1]).toEqual(requests[0]);
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
test("生产线按实例与版本分类，支持键盘切换、工单追踪与返回原列表", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.factoryLiveFixture.lineCount = 2;
    window.factoryLiveFixture.idleVersion = true;
    window.factoryLiveFixture.release = {
      agentId: "invoice-desk",
      displayName: "票据核对",
      version: "2.1.0",
      status: "pending_review",
    };
  });
  await page.getByRole("button", { name: /^智能体生产线，/ }).click();
  const panel = page.locator(".live-inspector");
  const tabs = panel.getByRole("tablist", { name: "智能体生产线" });
  const running = tabs.getByRole("tab", { name: "正在运行" });
  const ready = tabs.getByRole("tab", { name: "已上线" });
  const pending = tabs.getByRole("tab", { name: "待审核" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "正在运行",
    "已上线",
    "待审核",
  ]);
  await expect(running).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /新建智能体|管理智能体|装配/ }),
  ).toHaveCount(0);
  await expect(panel.getByText("共 2 个运行实例")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /报价核对 · v2.0.0/ }),
  ).toContainText("测试工单 · 试跑五月报价");
  await expect(
    panel.getByRole("button", { name: /报价核对 · v2.0.0/ }),
  ).toContainText("停止中");
  await expect(
    panel.getByRole("button", { name: /索引助理|票据核对/ }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: /实例 worker-42/ }).click();
  await expect(
    panel.getByRole("heading", { name: "正在执行的资料检索" }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "执行记录" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await panel.getByRole("button", { name: "返回上一级" }).click();
  await running.focus();
  await running.press("ArrowRight");
  await expect(ready).toBeFocused();
  await expect(panel.getByText("共 2 个版本")).toBeVisible();
  await expect(panel.getByRole("button", { name: /索引助理/ })).toContainText(
    "0 个运行实例",
  );
  await expect(panel.getByRole("button", { name: /审计助理/ })).toContainText(
    "v1.0.0",
  );
  await expect(panel.getByText(/v0.9.0/)).toHaveCount(0);
  await ready.press("End");
  await expect(pending).toBeFocused();
  await expect(panel.getByText("共 1 个版本")).toBeVisible();
  await panel.getByRole("button", { name: /票据核对/ }).click();
  await expect(
    panel.getByRole("heading", { name: "使用此版本的工单" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "审核并上线" }).click();
  await expect(panel.getByRole("button", { name: "下线版本" })).toBeVisible();
  await panel.getByRole("button", { name: "返回上一级" }).click();
  await expect(pending).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByText("共 0 个版本")).toBeVisible();
  await ready.click();
  await panel.getByRole("button", { name: /票据核对/ }).click();
  await panel.getByRole("button", { name: "下线版本" }).click();
  await panel.getByRole("button", { name: "确认下线" }).click();
  await expect(
    panel.getByRole("button", { name: "重新审核上线" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls
        .filter((c) => c.method === "POST")
        .map((c) => c.path),
    ),
  ).toEqual([
    "/v1/agents/invoice-desk/versions/2.1.0/approve",
    "/v1/factory/agents/invoice-desk/versions/2.1.0/offline",
  ]);
});

test("生产线读取失败可重试，切换页签时不会沿用另一类的结果", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.factoryLiveFixture.lineLoading = true;
  });
  await page.locator('[data-area="line"]').click();
  const panel = page.locator(".live-inspector");
  await expect(panel.getByText("正在读取…")).toBeVisible();
  await expect(panel.getByText(/共 0 个运行实例/)).toHaveCount(0);
  await panel.getByRole("tab", { name: "已上线" }).click();
  await expect(panel.getByText("共 1 个版本")).toBeVisible();
  await page.evaluate(() => {
    window.factoryLiveFixture.lineLoading = false;
    window.factoryLiveFixture.lineError = true;
  });
  await panel.getByRole("tab", { name: "正在运行" }).click();
  await expect(
    page.getByRole("region", { name: "桌面提示" }).getByRole("alert"),
  ).toContainText("运行实例暂时不可用");
  await expect(panel.getByText("共 1 个版本")).toHaveCount(0);
  await page.evaluate(() => {
    window.factoryLiveFixture.lineError = false;
    window.factoryLiveFixture.oldRuntimeApi = true;
  });
  await panel.getByRole("button", { name: "重新读取" }).click();
  await expect(
    page.getByRole("region", { name: "桌面提示" }).getByRole("alert"),
  ).toContainText("当前中台未提供生产线运行实例清单");
  await page.evaluate(() => {
    window.factoryLiveFixture.oldRuntimeApi = false;
    window.factoryLiveFixture.lineCount = 0;
  });
  await panel.getByRole("button", { name: "重新读取" }).click();
  await expect(panel.getByText("当前没有正在运行的实例")).toBeVisible();
  await expect(panel.getByText("共 0 个运行实例")).toBeVisible();
});

test("桌面与窄屏生产线标签保持一行，运行实例可翻页", async ({
  page,
}, testInfo) => {
  await page.evaluate(() => {
    window.factoryLiveFixture.lineCount = 21;
  });
  await page.locator('[data-area="line"]').click();
  const panel = page.locator(".live-inspector");
  await expect(panel.getByText("共 21 个运行实例")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /实例 worker-62/ }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "下一页" }).click();
  await expect(
    panel.getByRole("button", { name: /实例 worker-62/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "下一页" })).toBeDisabled();
  await panel.getByRole("button", { name: /实例 worker-62/ }).click();
  await panel.getByRole("button", { name: "返回上一级" }).click();
  await expect(
    panel.getByRole("button", { name: /实例 worker-62/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.factoryLiveFixture.lineCount = 2;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(panel.getByText("共 2 个运行实例")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /实例 worker-42/ }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /实例 worker-43/ }),
  ).toContainText("测试工单");
  for (const width of [1280, 412]) {
    await page.setViewportSize({ width, height: 820 });
    const boxes = await panel.getByRole("tab").evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, right, width } = button.getBoundingClientRect();
        return { x, y, right, width };
      }),
    );
    expect(boxes).toHaveLength(3);
    expect(new Set(boxes.map((box) => box.y)).size).toBe(1);
    expect(boxes[0].x).toBeGreaterThanOrEqual(0);
    expect(boxes[2].right).toBeLessThanOrEqual(width);
    expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].x);
    expect(boxes[1].right).toBeLessThanOrEqual(boxes[2].x);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("factory-line-" + width + ".png"),
    });
  }
  await panel.getByRole("tab", { name: "待审核" }).click();
  await panel.getByRole("tab", { name: "正在运行" }).click();
  await expect(
    panel.getByRole("button", { name: /实例 worker-42/ }),
  ).toBeVisible();
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
  await expect(
    page
      .getByRole("region", { name: "桌面提示" })
      .getByText("中台已确认停止该工单。"),
  ).toBeVisible();
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
  await page.locator('[data-area="line"]').click();
  await expect(panel.getByText("当前没有正在运行的实例")).toBeVisible();
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
  await panel.getByRole("tab", { name: "已上线" }).click();
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
  await expect(
    page.getByRole("region", { name: "桌面提示" }).getByRole("alert"),
  ).toContainText("task-running");
  await panel.getByRole("button", { name: "刷新智能体状态" }).click();
  await page.evaluate(() => {
    window.factoryLiveFixture.blockDeletion = false;
    window.factoryLiveFixture.revokeFails = true;
  });
  await confirm.getByRole("button", { name: "确认删除全部版本" }).click();
  await expect(
    page.getByRole("region", { name: "桌面提示" }).getByRole("alert"),
  ).toContainText("503");
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
    page
      .getByRole("region", { name: "桌面提示" })
      .getByText(/已删除智能体 audit-assistant 的全部 2 个登记版本/),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "删除此版本" })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() =>
      window.factoryLiveFixture.calls
        .filter((c) => c.path?.endsWith("/delete"))
        .map((c) => c.path),
    ),
  ).toEqual(Array(3).fill("/v1/factory/agents/audit-assistant/delete"));
  await panel.getByRole("button", { name: "返回上一级" }).click();
  await expect(panel.getByRole("tab", { name: "已上线" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
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
  await expect(
    modal.getByRole("region", { name: "桌面提示" }).getByRole("alert"),
  ).toBeVisible();
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
