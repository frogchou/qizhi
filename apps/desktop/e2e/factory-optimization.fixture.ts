import type { Page } from "@playwright/test";
import type {
  AssemblyDraft,
  AssemblyRun,
  OptimizationReceipt,
} from "../src/features/factory/assembly-model";

type Scenario = "failed" | "published" | "archived";
declare global {
  interface Window {
    optimizationFixture: {
      response: "ok" | "error" | "invalid" | "hold";
      acknowledge: () => void;
      advance: (state: "running" | "completed" | "failed") => void;
    };
  }
}

export async function installOptimizationFixture(
  page: Page,
  scenario: Scenario,
) {
  await page.evaluate(async (scenario) => {
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
    const base = "/v1/factory/assemblies";
    const source = (await previous("factory_request", {
      method: "GET",
      path: base + "/quote-draft",
    })) as AssemblyDraft;
    const build = source.candidates[0];
    const published = scenario === "published";
    const run: AssemblyRun = {
      id: "bound-run",
      taskId: "original-trial",
      candidateId: build.id,
      packageDigest: build.packageDigest,
      state: published ? "accepted" : "failed",
      accepted: published,
      candidateCompleted: published,
      feedback: published ? "原版报价已逐项核对" : "",
      reviewId: published ? "bound-review" : null,
      reviewDecision: published ? "accept" : null,
      reviewRound: published ? 2 : null,
      assertions: [
        {
          name: "汇率边界",
          required: true,
          passed: published,
          message: published ? "与基准相同" : "汇率缺失时输出错误",
        },
      ],
      criteria: [
        { id: "C1", priority: "required", requirement: "显示换算依据" },
      ],
      findings: [{ id: "C1", status: published ? "met" : "missing" }],
      businessReview: {
        status: published ? "met" : "missing",
        criteriaIds: ["C1"],
      },
      optimizationNeedsFeedback: published,
      createdAt: "2026-11-25T09:00:00Z",
      optimizations: [],
    };
    source.runs = [
      run,
      {
        ...structuredClone(run),
        id: "newer-other-run",
        taskId: "other-trial",
        createdAt: "2026-11-25T10:00:00Z",
      },
    ];
    if (scenario !== "failed") source.deletedAt = "2026-11-25T11:00:00Z";
    if (published) {
      build.releaseStatus = "ready";
      build.publishedRunId = run.id;
      window.factoryLiveFixture.release = {
        agentId: build.agentId,
        displayName: "正式报价核对",
        version: build.version,
        status: "ready",
        assembly: {
          draftId: source.id,
          candidateId: build.id,
          runId: run.id,
          packageDigest: build.packageDigest,
        },
      };
    }
    const drafts = new Map([[source.id, source]]);
    const receipts = new Map<string, OptimizationReceipt>();
    let target = source;
    let job = "";
    window.optimizationFixture = {
      response: "ok",
      acknowledge() {},
      advance(state) {
        const op = target.operations.find((item) => item.id === job)!;
        op.state = state;
        op.message =
          state === "running"
            ? "正在校验优化后的包和固定用例"
            : state === "failed"
              ? "本轮生成未通过固定用例校验"
              : "优化源码已封存";
        const record = run.optimizations!.find(
          (item) => item.operationId === job,
        )!;
        record.state = state;
        if (state === "completed") {
          const optimized = {
            ...structuredClone(build),
            id: job,
            version: target.config.version,
            revision: target.revision,
            config: { ...target.config },
            packageDigest: "b".repeat(64),
            releaseStatus: null,
            publishedRunId: null,
            createdAt: "2026-11-26T09:00:00Z",
          };
          target.candidates.push(optimized, {
            ...optimized,
            id: "later-unrelated-build",
            createdAt: "2026-11-26T10:00:00Z",
          });
        }
      },
    };
    ipc.invoke = async (cmd, args = {}) => {
      const path = args.path ?? "";
      if (cmd !== "factory_request") return previous(cmd, args);
      if (args.method === "GET" && path === base)
        return {
          items: Array.from(drafts.values()).filter((d) => !d.deletedAt),
        };
      const draft = drafts.get(path.slice(base.length + 1));
      if (args.method === "GET" && draft) return structuredClone(draft);
      if (!path.endsWith("/optimize")) return previous(cmd, args);
      window.factoryLiveFixture.calls.push(args);
      const body = args.body ?? {};
      if (
        args.method !== "POST" ||
        path !== base + "/" + source.id + "/runs/" + run.id + "/optimize" ||
        body.candidateId !== build.id ||
        body.packageDigest !== build.packageDigest ||
        body.revision !== source.revision ||
        body.reviewId !== run.reviewId
      )
        throw Error("本次优化与所选测试记录不匹配");
      if (window.optimizationFixture.response === "error")
        throw Error("中台连接中断，请重试。");
      if (window.optimizationFixture.response === "invalid")
        return { draftId: "wrong-target", state: "queued" };
      const key = String(body.requestId);
      if (receipts.has(key)) return structuredClone(receipts.get(key));
      if (window.optimizationFixture.response === "hold")
        await new Promise<void>((resolve) => {
          window.optimizationFixture.acknowledge = resolve;
        });
      if (published) {
        target = {
          ...structuredClone(source),
          id: "upgrade-" + (receipts.size + 1),
          revision: 1,
          baseRelease: { agentId: build.agentId, version: build.version },
          config: { ...source.config, version: "1.0.1" },
          deletedAt: null,
          operations: [],
          candidates: [],
          runs: [],
          messages: [],
        };
        drafts.set(target.id, target);
      }
      job = "optimization-" + (receipts.size + 1);
      const receipt = {
        draftId: target.id,
        operationId: job,
        revision: target.revision,
        state: "queued",
      };
      const createdAt = new Date().toISOString();
      target.operations.unshift({
        id: job,
        kind: "generate",
        state: "queued",
        createdAt,
        message: "生成请求已进入队列",
        optimizationSource: {
          draftId: source.id,
          candidateId: build.id,
          runId: run.id,
          packageDigest: build.packageDigest,
        },
      });
      run.optimizations!.unshift({
        ...receipt,
        createdAt,
        feedback: String(body.feedback),
      });
      receipts.set(key, receipt);
      return structuredClone(receipt);
    };
  }, scenario);
}
