import { useCallback, useEffect, useRef, useState } from "react";
import { factoryApi, type FactoryReadPath } from "./factory-client";
import {
  errorText,
  type Activity,
  type Changes,
  type Overview,
} from "./factory-model";

type Feed = {
  overview: Overview | null;
  events: Activity[];
  state: "loading" | "live" | "reconnecting";
  error: string;
  revision: number;
};
const initialFeed: Feed = {
  overview: null,
  events: [],
  state: "loading",
  error: "",
  revision: 0,
};

function mergeEvents(previous: Activity[], additions: Activity[]) {
  const keyed = new Map(previous.map((event) => [String(event.id), event]));
  for (const event of additions) keyed.set(String(event.id), event);
  return Array.from(keyed.values())
    .sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
        Number(b.id) - Number(a.id),
    )
    .slice(0, 40);
}

// One cursor belongs to one visible connection. Snapshot refreshes must never move a live cursor past unread changes.
export function useFactoryFeed(active = true) {
  const [feed, setFeed] = useState<Feed>(initialFeed);
  const [visible, setVisible] = useState(!document.hidden);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  useEffect(() => {
    if (!visible || !active) {
      setFeed((old) =>
        old.state === "loading" ? old : { ...old, state: "loading" },
      );
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let cursor: string | null = null;
    let pollTimer = 0,
      refreshTimer = 0,
      failures = 0,
      lastRefresh = 0;
    let reading: Promise<Overview> | null = null;
    function snapshot(): Promise<Overview> {
      if (reading) return reading;
      reading = factoryApi
        .get<Overview>("/v1/factory/overview", signal)
        .then((data) => {
          if (!data.areas || typeof data.cursor !== "string")
            throw new Error("中台返回的园区总览缺少状态或变更游标");
          if (!signal.aborted) {
            lastRefresh = Date.now();
            setFeed((old) => ({
              ...old,
              overview: data,
              events: mergeEvents(old.events, data.recentActivities ?? []),
              revision: old.revision + 1,
            }));
          }
          return data;
        })
        .finally(() => {
          reading = null;
        });
      return reading;
    }
    function markError(error: unknown) {
      if (!signal.aborted)
        setFeed((old) => ({
          ...old,
          state: "reconnecting",
          error: errorText(error),
        }));
    }
    function refresh() {
      if (refreshTimer || signal.aborted) return;
      refreshTimer = window.setTimeout(
        () => {
          refreshTimer = 0;
          void snapshot()
            .then(() => {
              if (!signal.aborted && !failures)
                setFeed((old) => ({ ...old, state: "live", error: "" }));
            })
            .catch(markError);
        },
        Math.max(0, 1000 - (Date.now() - lastRefresh)),
      );
    }
    refreshRef.current = refresh;
    async function poll() {
      let delay = 300;
      try {
        if (cursor === null || failures > 0) {
          const base = await snapshot();
          if (signal.aborted) return;
          if (cursor === null) {
            cursor = base.cursor;
            setFeed((old) => ({ ...old, state: "live", error: "" }));
          }
        }
        const page = await factoryApi.get<Changes>(
          `/v1/factory/changes?after=${encodeURIComponent(cursor)}&waitMs=20000`,
          signal,
        );
        if (signal.aborted) return;
        if (typeof page.cursor !== "string" || !Array.isArray(page.items))
          throw new Error("中台返回的变更记录格式不完整");
        const changed =
          page.items.length > 0 || Boolean(page.registryChanges?.length);
        cursor = page.cursor;
        if (failures > 0)
          setFeed((old) => ({ ...old, state: "live", error: "" }));
        failures = 0;
        if (page.items.length)
          setFeed((old) => ({
            ...old,
            events: mergeEvents(old.events, page.items),
          }));
        if (changed || Date.now() - lastRefresh > 30000) refresh();
        // Drain a real backlog quickly. Empty immediate responses from a proxy must never spin.
        delay = page.hasMore && changed ? 25 : changed ? 250 : 1000;
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        markError(error);
        // Reconcile with a snapshot on reconnect, then replay from the last acknowledged cursor.
        delay = Math.min(15000, 1000 * 2 ** Math.min(4, failures - 1));
      }
      if (!signal.aborted)
        pollTimer = window.setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(pollTimer);
      window.clearTimeout(refreshTimer);
      refreshRef.current = () => {};
    };
  }, [visible, active]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...feed, refresh };
}

type Read<T> = {
  path: string;
  data: T | null;
  error: string;
  loading: boolean;
  attempt: number;
};
export function useFactoryRead<T>(
  path: FactoryReadPath | null,
  revision: number,
) {
  const [result, setResult] = useState<Read<T>>({
    path: "",
    data: null,
    error: "",
    loading: true,
    attempt: 0,
  });
  const manualAttempt = useRef(0);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    if (!path) return;
    const control = new AbortController();
    let reading = false,
      requested = false;
    const request = async () => {
      if (reading) {
        requested = true;
        return;
      }
      reading = true;
      do {
        requested = false;
        const attempt = manualAttempt.current;
        setResult((old) => ({
          path,
          data: old.path === path ? old.data : null,
          loading: true,
          attempt: old.path === path ? old.attempt : 0,
          error: old.path === path ? old.error : "",
        }));
        try {
          const data = await factoryApi.get<T>(path, control.signal);
          if (!control.signal.aborted)
            setResult({ path, data, loading: false, error: "", attempt });
        } catch (error) {
          if (!control.signal.aborted)
            setResult((old) => ({
              path,
              data: old.path === path ? old.data : null,
              loading: false,
              attempt,
              error: errorText(error),
            }));
        }
      } while (requested && !control.signal.aborted);
      reading = false;
    };
    reload.current = () => void request();
    return () => {
      control.abort();
      reload.current = () => {};
    };
  }, [path]);
  useEffect(() => {
    reload.current();
  }, [path, revision]);
  const samePath = path === result.path;
  return {
    data: samePath ? result.data : null,
    error: samePath ? result.error : "",
    loading: Boolean(path && (!samePath || result.loading)),
    attempt: result.attempt,
    retry: () => {
      manualAttempt.current++;
      reload.current();
    },
  };
}

export type Collection =
  | "agents"
  | "tasks"
  | "quality"
  | "assets"
  | "runtimes"
  | "sources"
  | "monitor"
  | "deliveries"
  | "packages";
export function readPath(
  collection: Collection,
  filters: Record<string, string | number | undefined> = {},
): FactoryReadPath {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(key, String(value));
  const query = params.toString();
  return `/v1/factory/${collection}${query ? "?" + query : ""}` as FactoryReadPath;
}
