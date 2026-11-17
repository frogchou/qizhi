import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import {
  factoryOrigin,
  isLoopback,
  safeFactoryId,
  validFactoryRoute,
  type FactoryReadPath,
  type FactoryWritePath,
} from "./factory-routes";

export type { FactoryReadPath, FactoryWritePath } from "./factory-routes";
export type FactoryMode = "demo" | "live";
type ModeSnapshot = {
  mode: FactoryMode | "loading" | "error";
  endpoint: string;
  revision: number;
  error?: string;
};
export type FactorySettings = {
  mode: FactoryMode;
  endpoint: string;
  hasToken: boolean;
};
export type FactorySettingsInput = {
  mode: FactoryMode;
  endpoint: string;
  token: string;
};
const empty: FactorySettings = { mode: "demo", endpoint: "", hasToken: false };
const invalidConfig = "工厂设置读取失败，请重新打开设置并检查本机配置。";
const invalidRoute = "该工厂请求地址或参数无效。";
const invalidToken = "请为此控制面地址输入管理员令牌。";

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
const devOrigin = import.meta.env.DEV
  ? ((import.meta.env.QIZHI_FACTORY_DEV_ORIGIN as string | undefined) ?? "")
  : "";
export function factoryTransport(): "desktop" | "development" | "preview" {
  if (isDesktop()) return "desktop";
  return devOrigin && isLoopback(window.location.hostname)
    ? "development"
    : "preview";
}

// The optional loopback preview keeps connection and token only in this page's memory.
let browserSettings: FactorySettings = { ...empty, endpoint: devOrigin };
let browserToken = "";
let snapshot: ModeSnapshot = { mode: "loading", endpoint: "", revision: 0 };
const subscribers = new Set<() => void>();
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};
function publish(next: Omit<ModeSnapshot, "revision">): void {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  subscribers.forEach((notify) => notify());
}
function settingsResult(value: FactorySettings): FactorySettings {
  if (
    !value ||
    (value.mode !== "demo" && value.mode !== "live") ||
    typeof value.endpoint !== "string" ||
    typeof value.hasToken !== "boolean"
  )
    throw new Error(invalidConfig);
  return value;
}
export function factoryErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.length <= 180) return error;
  if (error instanceof Error && error.message.length <= 180)
    return error.message;
  return "工厂操作未完成，请检查连接后再试。";
}
export async function getFactorySettings(): Promise<FactorySettings> {
  return isDesktop()
    ? settingsResult(await invoke<FactorySettings>("factory_get_settings"))
    : { ...browserSettings };
}
async function initializeMode(): Promise<void> {
  const revision = snapshot.revision;
  try {
    const value = await getFactorySettings();
    if (snapshot.revision === revision)
      publish({ mode: value.mode, endpoint: value.endpoint });
  } catch {
    if (snapshot.revision === revision)
      publish({ mode: "error", endpoint: "", error: invalidConfig });
  }
}
let initial: Promise<void> | undefined;
export function useFactoryMode(): ModeSnapshot {
  const result = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => {
    initial ??= initializeMode();
  }, []);
  return result;
}

function draftToken(input: FactorySettingsInput, endpoint: string): string {
  const token =
    input.token.trim() ||
    (browserSettings.endpoint === endpoint ? browserToken : "");
  if (!token || token.length > 4096 || !/^[!-~]+$/.test(token))
    throw new Error(invalidToken);
  return token;
}
function developmentEndpoint(value: string): string {
  const endpoint = factoryOrigin(value);
  if (factoryTransport() !== "development" || endpoint !== devOrigin) {
    throw new Error(
      "浏览器实时模式需要本机开发服务器配置 QIZHI_FACTORY_DEV_ORIGIN。",
    );
  }
  return endpoint;
}
export async function saveFactorySettings(
  input: FactorySettingsInput,
): Promise<FactorySettings> {
  let saved: FactorySettings;
  if (isDesktop()) {
    saved = settingsResult(
      await invoke<FactorySettings>("factory_save_settings", { input }),
    );
  } else {
    const endpoint = input.endpoint.trim()
      ? developmentEndpoint(input.endpoint)
      : "";
    const token =
      input.mode === "live" || input.token.trim()
        ? draftToken(input, developmentEndpoint(endpoint))
        : browserSettings.endpoint === endpoint
          ? browserToken
          : "";
    browserToken = token;
    browserSettings = { mode: input.mode, endpoint, hasToken: !!token };
    saved = { ...browserSettings };
  }
  publish({ mode: saved.mode, endpoint: saved.endpoint });
  return saved;
}
export async function testFactoryConnection(
  input: FactorySettingsInput,
): Promise<void> {
  if (isDesktop()) return invoke<void>("factory_test_connection", { input });
  const endpoint = developmentEndpoint(input.endpoint);
  const token = draftToken(input, endpoint);
  const overview = await browserJson<{ cursor?: unknown }>(
    "GET",
    "/v1/factory/overview",
    token,
  );
  if (!overview || typeof overview.cursor !== "string")
    throw new Error("工厂服务返回了无效数据，请检查控制面版本。");
}

// Interpret only documented public reasons. The raw response is kept out of the UI.
async function operationFailure(
  path: string,
  response: Response,
): Promise<string | undefined> {
  const deletion =
    path.startsWith("/v1/factory/agents/") && path.endsWith("/delete");
  const stop = path.startsWith("/v1/tasks/") && path.endsWith("/stop");
  const review = path.startsWith("/v1/tasks/") && path.endsWith("/review");
  const { status } = response;
  const limit = 16 * 1024;
  if (
    (!deletion && !stop && !review) ||
    ![403, 409, 503].includes(status) ||
    Number(response.headers.get("content-length")) > limit
  )
    return;
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return;
      }
      text += decoder.decode(value, { stream: true });
    }
    const payload = JSON.parse(text + decoder.decode());
    if (review && status === 409) {
      if (payload?.code === "stale_review")
        return "验收轮次已变化，请刷新工单后再提交。";
      if (payload?.code === "idempotency_conflict")
        return "此次提交与上次请求不一致，请核对最新工单。";
    } else if (deletion) {
      if (status === 409 && payload?.code === "agent_in_use")
        return "仍有未结束的工单使用此智能体。请等待工单结束，或先停止相关工单，再刷新重试。";
      if (
        (status === 403 || status === 409) &&
        payload?.code === "agent_protected"
      )
        return "此智能体受中台保护，无法删除。";
      if (status === 409 && payload?.code === "agent_busy")
        return "智能体正在变更，请等待完成后刷新再试。";
      if (status === 503 && payload?.code === "agent_delete_incomplete")
        return "智能体删除尚未完成。请刷新查看状态，待服务恢复后重试删除。";
    } else if (status === 409) {
      if (
        payload?.code === "task_already_finished" ||
        payload?.message === "任务已经结束。"
      )
        return "工单已经结束，请刷新查看最终状态。";
      if (
        payload?.code === "task_stop_pending" ||
        payload?.message ===
          "节点管理服务未确认全部实例已停止，可重试停止任务。"
      )
        return "部分执行实例尚未确认停止。请刷新工单状态，必要时重试停止。";
    }
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

async function httpError(
  method: string,
  path: string,
  response: Response,
): Promise<Error> {
  const status = response.status;
  const reason =
    method === "POST" ? await operationFailure(path, response) : undefined;
  let message: string;
  if (reason) message = reason;
  else if (status === 401 || status === 403)
    message = "工厂拒绝访问，请检查管理员令牌和权限。";
  else if (status === 404)
    message = "工厂未找到该资源或接口，请刷新并检查控制面版本。";
  else if (status === 409)
    message = "服务器状态已变化或此操作与当前状态冲突，请刷新后重试。";
  else if ([400, 413, 422].includes(status))
    message = "工厂未接受请求，请检查填写的参数。";
  else message = "工厂暂时无法完成请求。";
  return new Error(`${message}（HTTP ${status}）`);
}

async function browserFetch<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  read: (response: Response) => Promise<T>,
  options: {
    body?: unknown;
    signal?: AbortSignal;
    idempotencyKey?: string;
    artifact?: boolean;
    multipart?: FormData;
  } = {},
): Promise<T> {
  if (
    factoryTransport() !== "development" ||
    !validFactoryRoute(method, path, options.artifact)
  )
    throw new Error(invalidRoute);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const limit =
    options.artifact || options.multipart
      ? 600000
      : method === "POST"
        ? 120000
        : path.startsWith("/v1/factory/changes")
          ? 40000
          : 20000;
  const timer = window.setTimeout(abort, limit);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: options.artifact ? "*/*" : "application/json",
      "X-Qizhi-Factory-Request": "1",
    };
    if (method === "POST" && !options.multipart)
      headers["Content-Type"] = "application/json";
    if (options.idempotencyKey)
      headers["Idempotency-Key"] = options.idempotencyKey;
    let response: Response;
    try {
      response = await fetch(`/__qizhi_factory${path}`, {
        method,
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        body:
          method === "POST"
            ? (options.multipart ?? JSON.stringify(options.body ?? {}))
            : undefined,
      });
    } catch {
      if (options.signal?.aborted)
        throw new DOMException("工厂查询已取消。", "AbortError");
      throw new Error(
        controller.signal.aborted
          ? "工厂请求超时，请刷新查看服务器状态。"
          : "无法连接工厂，请检查本机开发服务器和控制面地址。",
      );
    }
    if (!response.ok) throw await httpError(method, path, response);
    return await read(response);
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
function browserJson<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<T> {
  return browserFetch(
    method,
    path,
    token,
    async (response) => {
      if (response.status === 204) return null as T;
      try {
        return (await response.json()) as T;
      } catch {
        throw new Error("工厂服务返回了无效数据，请检查控制面地址和版本。");
      }
    },
    { body, signal, idempotencyKey },
  );
}
function activeBrowserToken(): string {
  if (
    browserSettings.mode !== "live" ||
    !browserToken ||
    factoryTransport() !== "development"
  )
    throw new Error("请在设置中连接实时工厂。");
  return browserToken;
}
function desktopGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!signal) return invoke<T>("factory_request", { method: "GET", path });
  if (signal.aborted)
    return Promise.reject(new DOMException("工厂查询已取消。", "AbortError"));
  const requestId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void invoke("factory_cancel_read", { requestId }).catch(() => undefined);
      reject(new DOMException("工厂查询已取消。", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void invoke<T>("factory_request", { method: "GET", path, requestId })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export type UploadReceipt = {
  id: string;
  displayName: string;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  mediaType: string;
  expiresAt: string;
};
export type LocalUpload = {
  displayName: string;
  status: "uploaded" | "failed";
  upload: UploadReceipt | null;
  error: string | null;
};
export const factoryApi = {
  async pickUploads(): Promise<LocalUpload[]> {
    if (!isDesktop()) throw new Error("此入口需要栖知桌面端。");
    return invoke<LocalUpload[]>("factory_pick_uploads");
  },
  async uploadBasket(itemId: string): Promise<UploadReceipt> {
    if (!isDesktop()) throw new Error("资料筐需要栖知桌面端。");
    return invoke<UploadReceipt>("factory_upload_basket_item", { itemId });
  },
  async uploadFile(file: File): Promise<UploadReceipt> {
    const data = new FormData();
    data.append("file", file, file.name);
    return browserFetch(
      "POST",
      "/v1/task-inputs/uploads",
      activeBrowserToken(),
      async (response) => {
        const { upload } = (await response.json()) as { upload: UploadReceipt };
        if (!upload?.id || !upload.expiresAt)
          throw new Error("中台没有返回有效的附件编号。");
        return upload;
      },
      { multipart: data },
    );
  },
  async get<T>(path: FactoryReadPath, signal?: AbortSignal): Promise<T> {
    if (!validFactoryRoute("GET", path)) throw new Error(invalidRoute);
    return isDesktop()
      ? desktopGet<T>(path, signal)
      : browserJson<T>("GET", path, activeBrowserToken(), undefined, signal);
  },
  async post<T>(
    path: FactoryWritePath,
    body?: unknown,
    options?: { idempotencyKey?: string },
  ): Promise<T> {
    if (!validFactoryRoute("POST", path)) throw new Error(invalidRoute);
    const idempotencyKey = path.endsWith("/respond")
      ? (options?.idempotencyKey ?? crypto.randomUUID())
      : path.endsWith("/review")
        ? options?.idempotencyKey
        : undefined;
    return isDesktop()
      ? invoke<T>("factory_request", {
          method: "POST",
          path,
          body: body ?? {},
          idempotencyKey,
        })
      : browserJson<T>(
          "POST",
          path,
          activeBrowserToken(),
          body,
          undefined,
          idempotencyKey,
        );
  },
  async download(
    taskId: string,
    artifactId: string,
    fileName: string,
  ): Promise<boolean> {
    if (!safeFactoryId(taskId) || !safeFactoryId(artifactId))
      throw new Error(invalidRoute);
    if (isDesktop())
      return invoke<boolean>("factory_download", {
        taskId,
        artifactId,
        fileName,
      });
    const path = `/v1/tasks/${taskId}/artifacts/${artifactId}`;
    const blob = await browserFetch(
      "GET",
      path,
      activeBrowserToken(),
      (response) => response.blob(),
      { artifact: true },
    );
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = (fileName.split(/[\\/]/).pop() || "工厂交付物")
      .replace(/[<>:"|?*]/g, "_")
      .slice(0, 140);
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  },
};
