import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactorySettingsSection } from "./FactorySettingsSection";
import type { FactorySettingsInput } from "../factory/factory-client";

afterEach(() => vi.unstubAllGlobals());
describe("factory settings", () => {
  it("tests an unsaved connection, saves live mode, then reuses its mask only for the saved address", async () => {
    const original = "http://127.0.0.1:3010";
    const invoke = vi.fn(
      async (command: string, args: { input?: FactorySettingsInput }) => {
        if (command === "factory_get_settings")
          return { mode: "demo", endpoint: "", hasToken: false };
        if (command === "factory_save_settings")
          return {
            mode: args.input?.mode,
            endpoint: args.input?.endpoint,
            hasToken: true,
          };
        return undefined;
      },
    );
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    render(<FactorySettingsSection />);
    const live = screen.getByRole("radio", { name: "实时工厂" });
    await waitFor(() => expect(live).toBeEnabled());
    expect(screen.getByRole("radio", { name: "演示模式" })).toBeChecked();
    fireEvent.click(live);
    expect(live).toBeChecked();
    fireEvent.change(screen.getByLabelText("工厂控制面地址"), {
      target: { value: original },
    });
    const token = screen.getByLabelText("工厂管理员令牌");
    expect(token).toHaveAttribute("type", "password");
    fireEvent.change(token, { target: { value: "fixture-only" } });
    fireEvent.click(screen.getByRole("button", { name: "测试工厂连接" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已通过管理员身份读取工厂总览",
    );
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "factory_save_settings",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "保存工厂设置" }));
    await waitFor(() => expect(token).toHaveValue(""));
    expect(token).toHaveAttribute("placeholder", "••••••••");
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "测试工厂连接" }));
    await waitFor(() =>
      expect(
        invoke.mock.calls
          .filter(([command]) => command === "factory_test_connection")
          .slice(-1)[0]?.[1].input?.token,
      ).toBe(""),
    );
    fireEvent.change(screen.getByLabelText("工厂控制面地址"), {
      target: { value: "http://127.0.0.1:3011" },
    });
    expect(token).not.toHaveAttribute("placeholder", "••••••••");
    expect(screen.getByRole("button", { name: "测试工厂连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存工厂设置" })).toBeDisabled();
  });
  it("opens as demo in a plain browser with a visible desktop connection explanation", async () => {
    render(<FactorySettingsSection />);
    const demo = screen.getByRole("radio", { name: "演示模式" });
    await waitFor(() => expect(demo).toBeEnabled());
    expect(demo).toBeChecked();
    expect(screen.getByRole("radio", { name: "实时工厂" })).toBeDisabled();
    expect(screen.queryByLabelText("工厂管理员令牌")).toBeNull();
  });
});
