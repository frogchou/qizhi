import { useState } from "react";

import "./App.css";
import { AppSidebar, type AppRoute } from "./components/AppSidebar";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TodayPage } from "./features/today/TodayPage";
import { unavailableCommands, type QizhiCommands } from "./lib/tauri";

function ComingSoon({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="page coming-soon">
      <p className="eyebrow">后续版本</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

function App({ commands = unavailableCommands }: { commands?: QizhiCommands }) {
  const [route, setRoute] = useState<AppRoute>("today");
  let content = <TodayPage commands={commands} />;
  if (route === "settings")
    content = (
      <section className="page settings-page">
        <SettingsPage commands={commands} />
      </section>
    );
  if (route === "knowledge")
    content = (
      <ComingSoon
        title="知识库问答"
        description="连接 RAGFlow 后，你将在这里检索并提问自己的知识库。"
      />
    );
  if (route === "codex")
    content = (
      <ComingSoon
        title="Codex 工作"
        description="检索、引用本机文件与知识片段，并交给 Codex 处理复杂任务。"
      />
    );
  return (
    <main className="app-shell">
      <AppSidebar active={route} onNavigate={setRoute} />
      <div className="workspace">{content}</div>
    </main>
  );
}

export default App;
