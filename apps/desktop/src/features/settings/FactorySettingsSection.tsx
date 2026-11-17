import { useEffect, useId, useState } from "react";
import { ControlIcon } from "../../components/ControlIcon";
import "./factory-settings.css";
import {
  factoryErrorMessage,
  factoryTransport,
  getFactorySettings,
  saveFactorySettings,
  testFactoryConnection,
  type FactoryMode,
  type FactorySettings,
} from "../factory/factory-client";

export function FactorySettingsSection() {
  const [saved, setSaved] = useState<FactorySettings | null>(null);
  const [mode, setMode] = useState<FactoryMode>("demo");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"load" | "test" | "save" | null>("load");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const transport = factoryTransport();
  const modeId = useId();
  useEffect(() => {
    let active = true;
    getFactorySettings()
      .then((value) => {
        if (!active) return;
        setSaved(value);
        setMode(value.mode);
        setEndpoint(value.endpoint);
      })
      .catch(() => {
        if (active)
          setNotice({
            ok: false,
            text: "未能读取工厂设置，请检查本机凭据管理器。",
          });
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, []);
  const hasSavedToken =
    saved?.hasToken && saved.endpoint === endpoint.trim().replace(/\/$/, "");
  const canConnect =
    transport !== "preview" &&
    !!endpoint.trim() &&
    (!!token.trim() || hasSavedToken);

  async function submit(action: "test" | "save") {
    setBusy(action);
    setNotice(null);
    try {
      const input = { mode, endpoint, token };
      if (action === "test") {
        await testFactoryConnection(input);
        setNotice({ ok: true, text: "已通过管理员身份读取工厂总览。" });
      } else {
        const value = await saveFactorySettings(input);
        setSaved(value);
        setEndpoint(value.endpoint);
        setToken("");
        setNotice({
          ok: true,
          text:
            value.mode === "demo"
              ? "已保存，智能工厂将使用演示数据。"
              : "已保存，智能工厂将读取该控制面的实时数据。",
        });
      }
    } catch (error) {
      setNotice({ ok: false, text: factoryErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      className="settings-block factory-settings"
      aria-labelledby="factory-settings-title"
    >
      <header className="factory-settings-head">
        <span className="service-icon" aria-hidden="true">
          <ControlIcon name="factory" size={21} />
        </span>
        <div>
          <h2 id="factory-settings-title">智能工厂</h2>
          <p>选择园区的数据来源和中台连接。</p>
        </div>
      </header>
      <div className="factory-settings-row factory-mode-row">
        <span className="factory-field-label" id={modeId + "-label"}>
          运行模式
        </span>
        <div className="factory-field-stack">
          <div
            role="radiogroup"
            aria-label="工厂运行模式"
            aria-describedby={modeId + "-description"}
            className="factory-mode-switch"
          >
            {(["demo", "live"] as const).map((value) => (
              <label key={value} className="factory-mode-option">
                <input
                  type="radio"
                  name={modeId}
                  value={value}
                  checked={mode === value}
                  disabled={
                    !!busy || (value === "live" && transport === "preview")
                  }
                  onChange={() => {
                    setMode(value);
                    setNotice(null);
                  }}
                />
                <span>
                  <ControlIcon
                    name={value === "demo" ? "layers" : "factory"}
                    size={15}
                  />
                  {value === "demo" ? "演示模式" : "实时工厂"}
                </span>
              </label>
            ))}
          </div>
          <p className="factory-field-hint" id={modeId + "-description"}>
            {transport === "preview"
              ? "浏览器预览使用模拟数据。实时工厂可在栖知桌面端连接。"
              : mode === "demo"
                ? "使用本地模拟工单演示园区流程。"
                : "从企业中台读取工单、运行动态和交付物。"}
          </p>
        </div>
      </div>
      {transport !== "preview" && (
        <>
          <div className="factory-settings-row">
            <label
              className="factory-field-label"
              htmlFor={modeId + "-address"}
            >
              中台地址
            </label>
            <div className="factory-field-stack">
              <input
                id={modeId + "-address"}
                className="ui-field"
                aria-label="工厂控制面地址"
                value={endpoint}
                disabled={!!busy || transport === "development"}
                placeholder="http://192.168.2.219:3010"
                spellCheck={false}
                aria-describedby={
                  endpoint.toLowerCase().startsWith("http://")
                    ? modeId + "-network"
                    : undefined
                }
                onChange={(e) => {
                  setEndpoint(e.currentTarget.value);
                  setNotice(null);
                }}
              />
              {endpoint.toLowerCase().startsWith("http://") && (
                <p
                  id={modeId + "-network"}
                  className="factory-field-hint factory-field-info"
                >
                  <ControlIcon name="info" size={14} />
                  请在受信任的内网使用此 HTTP 地址。
                </p>
              )}
            </div>
          </div>
          <div className="factory-settings-row">
            <label className="factory-field-label" htmlFor={modeId + "-token"}>
              管理员令牌
            </label>
            <div className="factory-field-stack">
              <input
                id={modeId + "-token"}
                className="ui-field"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                aria-label="工厂管理员令牌"
                aria-describedby={modeId + "-credentials"}
                disabled={!!busy}
                value={token}
                placeholder={hasSavedToken ? "••••••••" : "输入管理员令牌"}
                onChange={(e) => {
                  setToken(e.currentTarget.value);
                  setNotice(null);
                }}
              />
              <p className="factory-field-hint" id={modeId + "-credentials"}>
                {transport === "desktop"
                  ? "令牌保存在 Windows 凭据管理器中。更换地址后需重新输入。"
                  : "开发预览只在当前页面保存令牌，刷新后请重新输入。"}
              </p>
            </div>
          </div>
        </>
      )}
      <footer className="factory-settings-footer">
        {notice && (
          <p
            role={notice.ok ? "status" : "alert"}
            className={
              notice.ok ? "factory-feedback" : "factory-feedback is-error"
            }
          >
            <ControlIcon name={notice.ok ? "check" : "info"} size={15} />
            {notice.text}
          </p>
        )}
        <div className="factory-settings-actions">
          {transport !== "preview" && (
            <button
              type="button"
              className="ui-action"
              disabled={!!busy || !canConnect}
              onClick={() => void submit("test")}
            >
              <ControlIcon name="connection" />
              {busy === "test" ? "正在测试…" : "测试工厂连接"}
            </button>
          )}
          <button
            type="button"
            className="ui-action ui-primary"
            disabled={!!busy || (mode === "live" && !canConnect)}
            onClick={() => void submit("save")}
          >
            {busy === "save" ? "正在保存…" : "保存工厂设置"}
          </button>
        </div>
      </footer>
    </section>
  );
}
