import { FactoryPage } from "./FactoryPage";
import { useFactoryMode } from "./factory-client";
import { LiveFactoryPage } from "./LiveFactoryPage";

export function FactoryWorkspace({
  active,
  onOpenKnowledge,
  onOpenSettings,
}: {
  active: boolean;
  onOpenKnowledge: () => void;
  onOpenSettings: () => void;
}) {
  const connection = useFactoryMode();
  if (connection.mode === "demo")
    return <FactoryPage active={active} onOpenKnowledge={onOpenKnowledge} />;
  if (!active) return null;
  if (connection.mode === "live")
    return (
      <LiveFactoryPage
        key={connection.revision}
        endpoint={connection.endpoint}
        onKnowledge={onOpenKnowledge}
        onSettings={onOpenSettings}
      />
    );
  return (
    <section className="fc fc-connection">
      <header className="fc-head">
        <h1>智能工厂</h1>
      </header>
      <div className="live-connection-card">
        <h2>
          {connection.mode === "error"
            ? "无法读取中台连接配置"
            : "正在读取工厂设置"}
        </h2>
        {connection.error && <p role="alert">{connection.error}</p>}
        {connection.mode === "error" && (
          <button className="fc-primary" onClick={onOpenSettings}>
            打开连接设置
          </button>
        )}
      </div>
    </section>
  );
}
