import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import {
  factoryOrigin,
  isLoopback,
  validFactoryRoute,
} from "./src/features/factory/factory-routes.ts";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

function factoryProxy(origin: string): ProxyOptions {
  const prefix = "/__qizhi_factory";
  return {
    target: origin,
    changeOrigin: true,
    followRedirects: false,
    proxyTimeout: 600_000,
    rewrite: (path) => path.slice(prefix.length),
    bypass(req) {
      const host = req.headers.host;
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (!host || !peer || !(peer === "::1" || /^127\./.test(peer)))
        return false;
      let localHost: URL;
      try {
        localHost = new URL(`http://${host}`);
      } catch {
        return false;
      }
      const origin = req.headers.origin;
      const peerOrigin =
        origin === undefined ||
        origin === `http://${host}` ||
        origin === `https://${host}`;
      if (
        !isLoopback(localHost.hostname) ||
        !peerOrigin ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        req.headers["x-qizhi-factory-request"] !== "1" ||
        !req.headers.authorization?.startsWith("Bearer ") ||
        !validFactoryRoute(
          req.method ?? "",
          (req.url ?? "").slice(prefix.length),
          true,
        )
      )
        return false;
      // Only the explicitly supplied request token crosses the local development proxy.
      delete req.headers.cookie;
      delete req.headers["proxy-authorization"];
    },
    configure(proxy) {
      // This workspace runs Vite without the optional Node type package.
      const events = proxy as unknown as {
        on(
          name: "proxyRes",
          handler: (response: {
            headers: Record<string, string | string[] | undefined>;
          }) => void,
        ): void;
      };
      events.on("proxyRes", (response) => {
        delete response.headers["set-cookie"];
        delete response.headers.location;
        response.headers["cache-control"] = "no-store";
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const origin =
    command === "serve" && process.env.QIZHI_FACTORY_DEV_ORIGIN
      ? factoryOrigin(process.env.QIZHI_FACTORY_DEV_ORIGIN)
      : "";
  return {
    define: {
      "import.meta.env.QIZHI_FACTORY_DEV_ORIGIN": JSON.stringify(origin),
    },
    plugins: [react()],
    test: {
      environment: "jsdom",
      exclude: ["e2e/**", "node_modules/**", "dist/**"],
      setupFiles: ["./src/test/setup.ts"],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      proxy: origin
        ? { "^/__qizhi_factory/v1/": factoryProxy(origin) }
        : undefined,
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
