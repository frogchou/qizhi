export const factoryCollections = [
  "agents",
  "tasks",
  "quality",
  "assets",
  "runtimes",
  "sources",
  "monitor",
  "deliveries",
  "packages",
] as const;
type Collection = (typeof factoryCollections)[number];
export type FactoryReadPath =
  | "/v1/factory/overview"
  | `/v1/factory/agents/${string}/status`
  | `/v1/factory/${Collection | "changes"}${"" | `?${string}`}`
  | "/v1/tasks"
  | "/v1/agents"
  | `/v1/tasks/${string}`;
export type FactoryWritePath =
  | "/v1/tasks"
  | "/v1/factory/releases"
  | `/v1/factory/agents/${string}/delete`
  | `/v1/tasks/${string}/${"review" | "stop" | "approve"}`
  | `/v1/tasks/${string}/interactions/${string}/${"respond" | "cancel"}`
  | `/v1/agents/${string}/versions/${string}/approve`
  | `/v1/factory/agents/${string}/versions/${string}/offline`;

const filters = new Set([
  "state",
  "area",
  "agentId",
  "version",
  "sourceSystem",
  "taskId",
  "status",
  "runtime",
  "kind",
  "source",
]);
const id = /^(?:[A-Za-z0-9._+@-]|%2[Bb]){1,160}$/;
export function safeFactoryId(value: string): boolean {
  return id.test(value) && value !== "." && value !== "..";
}
const invalidControl = (str: string) =>
  Array.from(str).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function validQuery(name: string, query: string): boolean {
  if (!query) return false;
  const seen = new Set<string>();
  for (const pair of query.split("&")) {
    const split = pair.indexOf("=");
    if (split < 1) return false;
    const key = pair.slice(0, split);
    const value = new URLSearchParams(pair).get(key);
    if (!value || value.length > 512 || invalidControl(value) || seen.has(key))
      return false;
    seen.add(key);
    if (name === "changes") {
      if (key === "after" && /^[A-Za-z0-9._-]{1,192}$/.test(value)) continue;
      if (key === "waitMs" && /^\d+$/.test(value) && Number(value) <= 25000)
        continue;
      return false;
    }
    if (key === "limit" || key === "offset") {
      if (!/^\d+$/.test(value) || Number(value) > 4294967295) return false;
    } else if (!filters.has(key)) return false;
  }
  return true;
}

export function validFactoryRoute(
  method: string,
  path: string,
  artifact = false,
): boolean {
  if (
    !path.startsWith("/v1/") ||
    path.length > 4096 ||
    path.includes("\\") ||
    path.includes("#") ||
    invalidControl(path)
  )
    return false;
  const mark = path.indexOf("?");
  const segments = (mark < 0 ? path : path.slice(0, mark)).slice(4).split("/");
  const [group, a, b, c, d, e] = segments;
  const length = segments.length;
  if (method === "GET" && group === "factory" && length === 2) {
    if (a === "overview") return mark < 0;
    return (
      (a === "changes" || factoryCollections.some((name) => name === a)) &&
      (mark < 0 || validQuery(a, path.slice(mark + 1)))
    );
  }
  if (mark >= 0) return false;
  if (method === "GET") {
    if (group === "factory")
      return (
        length === 4 && a === "agents" && safeFactoryId(b) && c === "status"
      );
    if (length === 1) return group === "tasks" || group === "agents";
    if (group !== "tasks" || !safeFactoryId(a)) return false;
    return (
      length === 2 ||
      (b === "interactions" &&
        (length === 3 || (length === 4 && safeFactoryId(c)))) ||
      (artifact && length === 4 && b === "artifacts" && safeFactoryId(c))
    );
  }
  if (method !== "POST") return false;
  if (group === "task-inputs") return length === 2 && a === "uploads";
  if (group === "factory") {
    return (
      (length === 2 && a === "releases") ||
      (length === 4 && a === "agents" && safeFactoryId(b) && c === "delete") ||
      (length === 6 &&
        a === "agents" &&
        safeFactoryId(b) &&
        c === "versions" &&
        safeFactoryId(d) &&
        e === "offline")
    );
  }
  if (group === "agents")
    return (
      length === 5 &&
      safeFactoryId(a) &&
      b === "versions" &&
      safeFactoryId(c) &&
      d === "approve"
    );
  if (group !== "tasks") return false;
  return (
    length === 1 ||
    (safeFactoryId(a) &&
      ((length === 3 && ["review", "stop", "approve"].includes(b)) ||
        (length === 5 &&
          b === "interactions" &&
          safeFactoryId(c) &&
          ["respond", "cancel"].includes(d))))
  );
}

export function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function factoryOrigin(value: string): string {
  const message = "请输入 HTTPS 控制面地址，或受信任的本机、内网 HTTP 地址。";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(message);
  }
  const host = url.hostname;
  const local =
    isLoopback(host) ||
    (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) &&
      /^[\d.]+$/.test(host)) ||
    /^\[f[cd][\da-f]{2}:/i.test(host);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    value.includes("@") ||
    value.includes("#") ||
    value.includes("?") ||
    value.includes("\\") ||
    invalidControl(value.trim()) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  )
    throw new Error(message);
  return url.origin;
}
