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
type Assembly = "/v1/factory/assemblies";
type Resources = "/v1/factory/assembly-resources";
export type FactoryReadPath =
  | Assembly
  | Resources
  | `${Assembly}/${string}`
  | `${Resources}/${"mcp" | "skill"}/${string}/${string}`
  | "/v1/factory/overview"
  | `/v1/factory/agents/${string}/status`
  | `/v1/factory/agents/${string}/versions/${string}/upgrade`
  | `/v1/factory/${Collection | "changes"}${"" | `?${string}`}`
  | "/v1/tasks"
  | "/v1/agents"
  | `/v1/tasks/${string}`;
export type FactoryWritePath =
  | Assembly
  | Resources
  | `${Assembly}/${string}/${"save" | "suggest" | "generate" | "delete" | "runs" | "publish"}`
  | `${Assembly}/${string}/operations/${string}/stop`
  | `${Assembly}/${string}/runs/${string}/${"accept" | "optimize"}`
  | `${Resources}/${"mcp" | "skill"}/${string}/${string}/state`
  | "/v1/tasks"
  | "/v1/factory/releases"
  | `/v1/factory/agents/${string}/delete`
  | `/v1/tasks/${string}/${"review" | "stop" | "approve"}`
  | `/v1/tasks/${string}/interactions/${string}/${"respond" | "cancel"}`
  | `/v1/agents/${string}/versions/${string}/approve`
  | `/v1/factory/agents/${string}/versions/${string}/${"offline" | "delete"}`;

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
    } else if (key === "search") {
      if (name !== "agents" || value.length > 160) return false;
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
  if (
    group === "factory" &&
    (a === "assemblies" || a === "assembly-resources")
  ) {
    if (mark >= 0 || (method !== "GET" && method !== "POST")) return false;
    if (length === 2) return true;
    if (a === "assembly-resources")
      return (
        (b === "skill" || b === "mcp") &&
        safeFactoryId(c) &&
        safeFactoryId(d) &&
        ((method === "GET" && length === 5) ||
          (method === "POST" && length === 6 && e === "state"))
      );
    if (!safeFactoryId(b)) return false;
    if (method === "GET")
      return (
        length === 3 ||
        (length === 6 &&
          c === "candidates" &&
          safeFactoryId(d) &&
          e === "source")
      );
    return (
      (length === 4 &&
        ["save", "suggest", "generate", "delete", "runs", "publish"].includes(
          c,
        )) ||
      (length === 6 &&
        safeFactoryId(d) &&
        ((c === "operations" && e === "stop") ||
          (c === "runs" && (e === "accept" || e === "optimize"))))
    );
  }
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
        a === "agents" &&
        safeFactoryId(b) &&
        ((length === 4 && c === "status") ||
          (length === 6 &&
            c === "versions" &&
            safeFactoryId(d) &&
            e === "upgrade"))
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
        (e === "offline" || e === "delete"))
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
  const message = "请输入 HTTP 或 HTTPS 控制面地址。";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(message);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    value.includes("@") ||
    value.includes("#") ||
    value.includes("?") ||
    value.includes("\\") ||
    invalidControl(value.trim()) ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  )
    throw new Error(message);
  return url.origin;
}
