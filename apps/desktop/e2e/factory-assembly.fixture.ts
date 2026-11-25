import type { Page } from "@playwright/test";

export async function installAssemblyFixture(page: Page) {
  await page.evaluate(() => {
    type Args = {
      method?: string;
      path?: string;
      body?: Record<string, unknown>;
    };
    const ipc = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Args) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const previous = ipc.invoke;
    const config = {
      agentId: "quote-desk",
      displayName: "报价核对",
      version: "1.0.0",
      capability: "enterprise.quote.reconcile",
      description: "按币种和生效日核对",
      workflow: "比较两份报价",
      criteria: ["列出差异"],
      skills: [] as string[],
      mcpTools: [] as string[],
      datasetIds: [] as string[],
      capabilities: [] as string[],
    };
    const resource = {
      kind: "mcp",
      id: "send",
      version: "1.0.0",
      label: "发送通知",
      description: "向指定收件人发送通知",
      effect: "external_write",
      state: "active",
    };
    const options = {
      skills: [
        {
          id: "quote-rules@1.0.0",
          version: "1.0.0",
          label: "报价规范",
          description: "正式报价格式",
        },
      ],
      mcpTools: [{ ...resource, id: "send@1.0.0" }],
      capabilities: [
        {
          id: "knowledge.retrieve",
          label: "检索资料",
          description: "查询已授权知识库",
          effect: "read",
        },
      ],
      datasets: [
        { id: "products", name: "产品资料" },
        { id: "prices", name: "采购报价" },
      ],
      connection: { status: "connected", message: "RAGFlow 已连接" },
    };
    const now = new Date().toISOString();
    const candidate = {
      id: "sealed-one",
      agentId: "quote-desk",
      version: "1.0.0",
      revision: 1,
      packageDigest: "a".repeat(64),
      buildEnvironment: "node22-sandbox",
      createdAt: now,
      config: { ...config },
      releaseStatus: null as string | null,
      publishedRunId: null as string | null,
    };
    const draft = {
      id: "quote-draft",
      revision: 1,
      description: "核对五月生效的报价",
      updatedAt: now,
      config,
      messages: [] as { role: string; content: string }[],
      operations: [] as {
        id: string;
        kind: string;
        state: string;
        message: string;
        createdAt: string;
      }[],
      suggestions: {
        skills: ["quote-rules@1.0.0"],
        mcpTools: [],
        capabilities: [],
        datasetIds: [],
      },
      candidates: [
        candidate,
        {
          ...candidate,
          id: "sealed-older",
          createdAt: new Date(Date.parse(now) - 60000).toISOString(),
        },
      ],
      runs: [] as {
        id: string;
        candidateId: string;
        taskId: string;
        state: string;
        accepted: boolean;
        assertions: {
          name: string;
          required: boolean;
          passed: boolean;
          message: string;
        }[];
        createdAt: string;
      }[],
    };
    const resources: Record<string, unknown>[] = [resource];
    let derived: typeof draft | undefined;
    let removedVersion = false;
    let generationAttempts = 0;
    (window as unknown as { amendFactoryDraft: () => void }).amendFactoryDraft =
      () => {
        draft.revision++;
        draft.config = { ...draft.config, workflow: "中台新增汇率校验" };
      };
    const base = "/v1/factory/assemblies";
    const lib = "/v1/factory/assembly-resources";
    const version = "/v1/factory/agents/audit-assistant/versions/0.9.0/delete";
    ipc.invoke = async (cmd, args = {}) => {
      const path = args.path ?? "",
        body = args.body ?? {};
      if (
        cmd === "factory_request" &&
        removedVersion &&
        path.split("?")[0] === "/v1/factory/agents"
      ) {
        const p = (await previous(cmd, args)) as {
          items: { agentId: string; version: string }[];
          total: number;
        };
        const items = p.items.filter(
          (a) => a.agentId !== "audit-assistant" || a.version !== "0.9.0",
        );
        return { ...p, items, total: items.length };
      }
      if (
        cmd !== "factory_request" ||
        (!path.startsWith(base) &&
          !path.startsWith(lib) &&
          path !== version &&
          path !== "/v1/tasks/capability-options" &&
          !path.includes("trial-order"))
      )
        return previous(cmd, args);
      window.factoryLiveFixture.calls.push(args);
      if (window.factoryLiveFixture.disconnect)
        throw new Error("中台暂时不可用");
      if (path === "/v1/tasks/capability-options")
        return [
          ...(window.factoryLiveFixture.readyCandidate
            ? [
                {
                  capability: "enterprise.quote.reconcile",
                  displayName: "正式报价核对",
                  description: "核对报价",
                  effect: "compose",
                  defaultDelegation: false,
                  agentId: "quote-desk",
                  version: "1.0.0",
                },
              ]
            : []),
          {
            capability: "knowledge.retrieve",
            displayName: "检索资料",
            description: "检索",
            effect: "read",
            defaultDelegation: true,
            agentId: "reader",
            version: "1.0.0",
          },
        ];
      if (path === version) {
        removedVersion = true;
        return {
          agentId: "audit-assistant",
          version: "0.9.0",
          status: "deleted",
        };
      }
      if (path === lib && args.method === "GET")
        return {
          items: resources,
          providers: [
            {
              id: "notifier",
              label: "通知服务",
              description: "发送通知",
              effect: "external_write",
            },
          ],
        };
      if (path === lib && args.method === "POST") {
        const files = (body.files ?? []) as {
          path: string;
          contentBase64: string;
        }[];
        const detail = await Promise.all(
          files.map(async (file) => {
            const bytes = Uint8Array.from(atob(file.contentBase64), (c) =>
              c.charCodeAt(0),
            );
            const sum = new Uint8Array(
              await crypto.subtle.digest("SHA-256", bytes),
            );
            return {
              ...file,
              sha256: Array.from(sum, (b) =>
                b.toString(16).padStart(2, "0"),
              ).join(""),
            };
          }),
        );
        resources.push({
          ...body,
          state: "active",
          ...(body.kind === "skill"
            ? { files: detail, fileCount: detail.length }
            : {}),
        });
        return body;
      }
      if (path.startsWith(lib + "/") && args.method === "GET") {
        const [, id, version] = path.slice(lib.length + 1).split("/");
        return resources.find((r) => r.id === id && r.version === version);
      }
      if (path.endsWith("/state")) {
        const row = resources.find((r) => r.id === path.split("/")[5]);
        if (row) row.state = body.state;
        return { state: body.state };
      }
      if (path === base + "/options") return options;
      if (path === base && args.method === "GET")
        return { items: derived ? [derived, draft] : [draft] };
      if (path === base && args.method === "POST") {
        if (body.baseRelease) {
          derived = {
            ...structuredClone(draft),
            id: "derived-draft",
            revision: 1,
            config: { ...structuredClone(candidate.config), version: "1.0.1" },
            candidates: [],
            runs: [],
            operations: [],
          };
          return structuredClone(derived);
        }
        draft.description = String(body.description);
        Object.assign(draft.config, body.config);
        draft.revision++;
        return draft;
      }
      if (derived && path === base + "/" + derived.id)
        return structuredClone(derived);
      if (path === base + "/quote-draft") {
        if (window.factoryLiveFixture.readyCandidate)
          return {
            ...structuredClone(draft),
            candidates: [
              {
                ...candidate,
                releaseStatus: "ready",
                config: {
                  ...candidate.config,
                  capabilities: ["knowledge.retrieve"],
                  datasetIds: ["products"],
                  mcpTools: ["send@1.0.0"],
                },
              },
            ],
          };
        return structuredClone(draft);
      }
      if (path.endsWith("/save")) {
        if (body.revision !== draft.revision)
          throw new Error("编辑修订冲突（HTTP 409）");
        draft.description = String(body.description);
        draft.config = body.config as typeof config;
        draft.revision++;
        return structuredClone(draft);
      }
      if (path.endsWith("/suggest")) {
        draft.messages.push({
          role: "assistant",
          content: "遇到同币种的两份有效报价，应选哪份？",
        });
        draft.operations.push({
          id: "clarify-one",
          kind: "suggest",
          state: "succeeded",
          message: "已整理委托",
          createdAt: now,
        });
        return { id: "clarify-one", state: "queued" };
      }
      if (path.endsWith("/generate")) {
        generationAttempts++;
        if (generationAttempts === 1) throw Error("中台暂时不可用，请重试。");
        draft.operations.push({
          id: "generate-one",
          kind: "generate",
          state: "running",
          message: "校验候选源码",
          createdAt: now,
        });
        return { id: "generate-one", state: "queued" };
      }
      if (path.endsWith("/operations/generate-one/stop")) {
        const op = draft.operations.find((o) => o.id === "generate-one")!;
        op.state = "cancelled";
        op.message = "用户已停止操作";
        return op;
      }
      if (path.endsWith("/source"))
        return {
          files: [
            {
              path: "src/quote.ts",
              content: "return amount * rate;",
              previousContent: "return amount;",
            },
          ],
        };
      if (path.endsWith("/runs")) {
        const run = {
          id: "run-one",
          candidateId: String(body.candidateId),
          taskId: "trial-order",
          state: "awaiting_user_input",
          accepted: false,
          createdAt: now,
          assertions: [
            {
              name: "生效日边界",
              required: true,
              passed: true,
              message: "边界报价计算正确",
            },
          ],
          criteria: [
            { id: "R1", priority: "required", requirement: "交付报价差异" },
          ],
          findings: [{ id: "R1", status: "met", reason: "已生成差异文件" }],
          candidateCompleted: true,
          receipts: [
            {
              resource: "send@1.0.0",
              effect: "external_write",
              mode: "simulated",
              provider: "preview-adapter",
              status: "completed",
              requestKey: "preview-01",
            },
          ],
        };
        draft.runs.push(run);
        return run;
      }
      if (path === "/v1/tasks/trial-order/interactions/question/respond") {
        draft.runs[0].state = "awaiting_review";
        return { accepted: true };
      }
      if (path === "/v1/tasks/trial-order") {
        const detail = (await previous(cmd, {
          method: "GET",
          path: "/v1/tasks/task-running",
        })) as Record<string, unknown>;
        return {
          ...detail,
          task: {
            ...(detail.task as object),
            id: "trial-order",
            goal: "试跑五月报价",
            state: draft.runs[0].state,
          },
          interactions:
            draft.runs[0].state === "awaiting_user_input"
              ? [
                  {
                    id: "question",
                    title: "确认货币",
                    prompt: "请输入结算币种",
                    state: "pending",
                    responseSchema: {
                      type: "object",
                      properties: { currency: { type: "string" } },
                      required: ["currency"],
                      additionalProperties: false,
                    },
                  },
                ]
              : [],
        };
      }
      if (path.endsWith("/accept")) {
        draft.runs[0].accepted = true;
        draft.runs[0].state = "accepted";
        return draft.runs[0];
      }
      if (path.endsWith("/publish")) {
        candidate.releaseStatus = "pending_review";
        candidate.publishedRunId = "run-one";
        window.factoryLiveFixture.release = {
          agentId: candidate.agentId,
          displayName: candidate.config.displayName,
          version: candidate.version,
          status: candidate.releaseStatus,
          assembly: {
            draftId: draft.id,
            candidateId: candidate.id,
            runId: candidate.publishedRunId,
            packageDigest: candidate.packageDigest,
          },
        };
        return {
          agentId: "quote-desk",
          version: "1.0.0",
          status: "pending_review",
        };
      }
      throw Error("未登记装配测试接口 " + path);
    };
  });
}
