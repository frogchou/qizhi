import { ControlIcon } from "../../components/ControlIcon";
import { AssemblyWorkspace } from "./AssemblyWorkspace";
import { useFactoryMode } from "./factory-client";
import { useFactoryFeed } from "./factory-feed";
import type { OpenTask } from "./factory-model";
import type { TaskScope, UpgradeEntry } from "./assembly-model";

type PageProps = {
  active: boolean;
  onSettings: () => void;
  onTask: OpenTask;
  onNewTask: (scope: TaskScope) => void;
};

export function AssemblyPage({
  entry,
  ...props
}: PageProps & { entry?: { endpoint: string; target: UpgradeEntry } }) {
  const connection = useFactoryMode();
  if (connection.mode === "live")
    return (
      <ConnectedAssembly
        key={connection.endpoint}
        {...props}
        endpoint={connection.endpoint}
        entry={
          entry?.endpoint === connection.endpoint ? entry.target : undefined
        }
      />
    );
  if (!props.active) return null;
  const loading = connection.mode === "loading";
  return (
    <section className="fc fc-live assembly-studio" aria-label="智能体装配">
      <div className="studio-shell">
        <header className="studio-header">
          <h1>智能体装配</h1>
        </header>
        <section className="studio-connect">
          <ControlIcon name="connection" size={32} />
          <h2>{loading ? "正在读取连接设置" : "连接智能工厂中台"}</h2>
          {connection.error && <p role="alert">{connection.error}</p>}
          {!loading && (
            <>
              <p>在连接设置中启用实时模式，即可创建、测试和管理智能体。</p>
              <button
                type="button"
                className="ui-action ui-primary"
                onClick={props.onSettings}
              >
                打开连接设置
              </button>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

function ConnectedAssembly({
  active,
  ...props
}: PageProps & { endpoint: string; entry?: UpgradeEntry }) {
  const feed = useFactoryFeed(active);
  return (
    <AssemblyWorkspace
      {...props}
      active={active}
      revision={feed.revision}
      connection={feed.state}
      onChange={feed.refresh}
    />
  );
}
