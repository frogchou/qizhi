import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("factory development action responses", () => {
  it("shows approved reasons from the server and discards diagnostic fields and oversized error bodies", async () => {
    const endpoint = "http://127.0.0.1:3010";
    vi.stubEnv("QIZHI_FACTORY_DEV_ORIGIN", endpoint);
    const { factoryApi, saveFactorySettings } =
      await import("./factory-client");
    await saveFactorySettings({
      mode: "live",
      endpoint,
      token: "local-test-only",
    });
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const deleting = "/v1/factory/agents/x/delete";
    const stopping = "/v1/tasks/a/stop";
    const privateInfo = "private diagnostic";
    const response = (status: number, payload: Record<string, unknown>) =>
      new Response(JSON.stringify({ ...payload, debug: privateInfo }), {
        status,
        headers: { "content-type": "application/json" },
      });
    for (const [path, status, body, text] of [
      [
        deleting,
        409,
        {
          code: "agent_in_use",
          message: privateInfo,
          taskIds: ["private task"],
        },
        "仍有未结束的工单",
      ],
      [
        deleting,
        409,
        { code: "agent_busy", message: privateInfo },
        "智能体正在变更",
      ],
      [
        deleting,
        403,
        { code: "agent_protected", message: privateInfo },
        "受中台保护",
      ],
      [
        deleting,
        503,
        { code: "agent_delete_incomplete", message: privateInfo },
        "删除尚未完成",
      ],
      [stopping, 409, { message: "任务已经结束。" }, "工单已经结束"],
      [
        stopping,
        409,
        { message: "节点管理服务未确认全部实例已停止，可重试停止任务。" },
        "尚未确认停止",
      ],
      [deleting, 409, { message: privateInfo }, "服务器状态已变化"],
      [
        deleting,
        409,
        { code: "agent_in_use", padding: "x".repeat(20_000) },
        "服务器状态已变化",
      ],
    ] as const) {
      request.mockResolvedValueOnce(response(status, body));
      const message = await factoryApi.post(path).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(message).toContain(text);
      expect(message).not.toContain(privateInfo);
      expect(message).not.toContain("private task");
      expect(message).toContain(String(status));
    }
  });
});
