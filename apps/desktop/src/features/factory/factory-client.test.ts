import { afterEach, describe, expect, it, vi } from "vitest";
import { factoryApi, getFactorySettings } from "./factory-client";
import { factoryOrigin, validFactoryRoute } from "./factory-routes";

afterEach(() => vi.unstubAllGlobals());

describe("factory desktop transport", () => {
  it("routes identity status, deletion, and task stop through the shared IPC and development proxy allowlist", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    await factoryApi.get("/v1/factory/agents/quality-agent/status");
    await factoryApi.post("/v1/factory/agents/quality-agent/delete");
    await factoryApi.post("/v1/tasks/demo-id/stop");
    expect(
      invoke.mock.calls.map(([, args]) => [args.method, args.path]),
    ).toEqual([
      ["GET", "/v1/factory/agents/quality-agent/status"],
      ["POST", "/v1/factory/agents/quality-agent/delete"],
      ["POST", "/v1/tasks/demo-id/stop"],
    ]);
    for (const [method, path] of [
      ["POST", "/v1/factory/agents/quality-agent/status"],
      ["GET", "/v1/factory/agents/a/delete"],
      ["DELETE", "/v1/factory/agents/a/delete"],
      ["POST", "/v1/factory/agents/a/delete?force=1"],
      ["POST", "/v1/factory/agents/a/versions/1.0.0/delete"],
      ["POST", "/v1/factory/agents/%2e%2e/delete"],
      ["GET", "/v1/factory/agents/%2f/status"],
      ["GET", "/v1/tasks/demo-id/stop"],
    ])
      expect(validFactoryRoute(method, path)).toBe(false);
  });
  it("reads masks and performs allowlisted requests through IPC without an address or token", async () => {
    const invoke = vi.fn().mockResolvedValue({
      mode: "live",
      endpoint: "http://127.0.0.1:3010",
      hasToken: true,
    });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    expect(await getFactorySettings()).toEqual({
      mode: "live",
      endpoint: "http://127.0.0.1:3010",
      hasToken: true,
    });
    expect(invoke).toHaveBeenCalledWith("factory_get_settings", {}, undefined);
    const path = "/v1/factory/tasks?limit=8&state=running";
    await factoryApi.get(path);
    expect(invoke).toHaveBeenCalledWith(
      "factory_request",
      { method: "GET", path },
      undefined,
    );
    await factoryApi.download("task-a", "artifact-a", "演示.pdf");
    expect(invoke).toHaveBeenCalledWith(
      "factory_download",
      { taskId: "task-a", artifactId: "artifact-a", fileName: "演示.pdf" },
      undefined,
    );
    await factoryApi.post(
      "/v1/tasks/task-a/interactions/interaction-a/respond",
      { response: { ok: true } },
      { idempotencyKey: "retry-one" },
    );
    expect(invoke).toHaveBeenCalledWith(
      "factory_request",
      {
        method: "POST",
        path: "/v1/tasks/task-a/interactions/interaction-a/respond",
        body: { response: { ok: true } },
        idempotencyKey: "retry-one",
      },
      undefined,
    );
  });
  it("cancels an outstanding native long poll when the page is left", async () => {
    const invoke = vi
      .fn()
      .mockImplementation((command: string) =>
        command === "factory_cancel_read"
          ? Promise.resolve()
          : new Promise(() => {}),
      );
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const controller = new AbortController();
    const query = factoryApi.get(
      "/v1/factory/changes?after=abc.1&waitMs=25000",
      controller.signal,
    );
    controller.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    const args = invoke.mock.calls[0][1] as { requestId: string };
    expect(args.requestId).toHaveLength(36);
    expect(invoke).toHaveBeenCalledWith(
      "factory_cancel_read",
      { requestId: args.requestId },
      undefined,
    );
  });
  it("protects methods, paths, opaque cursors and proxy targets", () => {
    expect(
      validFactoryRoute("POST", "/v1/agents/a/versions/1.0.0%2Bbuild/approve"),
    ).toBe(true);
    expect(
      validFactoryRoute(
        "GET",
        "/v1/factory/changes?after=abc_-.1&waitMs=25000",
      ),
    ).toBe(true);
    for (const path of [
      "/v1/tasks/%2e%2e",
      "//bad/v1/factory/tasks",
      "/v1/factory/changes?after=0&after=2",
      "/v1/factory/changes?waitMs=25001",
      "/v1/factory/tasks?url=http://bad",
    ])
      expect(validFactoryRoute("GET", path)).toBe(false);
    expect(validFactoryRoute("POST", "/v1/agents/discover")).toBe(false);
    expect(validFactoryRoute("GET", "/v1/tasks/t/artifacts/a")).toBe(false);
    expect(validFactoryRoute("GET", "/v1/tasks/t/artifacts/a", true)).toBe(
      true,
    );
    expect(factoryOrigin("http://192.168.2.219:3010/")).toBe(
      "http://192.168.2.219:3010",
    );
    expect(factoryOrigin("http://121.28.95.155:3010/")).toBe(
      "http://121.28.95.155:3010",
    );
    expect(factoryOrigin("http://public.example/")).toBe(
      "http://public.example",
    );
    for (const input of [
      "https://host/path",
      "https://one@host",
      "https://host/?token=private",
      "https://host/#token",
    ])
      expect(() => factoryOrigin(input)).toThrow();
  });
});
