import { useState } from "react";

import "./App.css";
import { AppSidebar, type AppRoute } from "./components/AppSidebar";
import { SettingsPage } from "./features/settings/SettingsPage";
import { KnowledgePage } from "./features/knowledge/KnowledgePage";
import { TodayPage } from "./features/today/TodayPage";
import { CodexPage } from "./features/codex/CodexPage";
import {
  unavailableCommands,
  type CodexHandoffResult,
  type QizhiCommands,
} from "./lib/tauri";

export type CodexNavigationTarget = {
  projectId: string;
  conversationId: string;
  handoffId: string;
  nonce: number;
};

function App({ commands = unavailableCommands }: { commands?: QizhiCommands }) {
  const [route, setRoute] = useState<AppRoute>("today");
  const [knowledgeMounted, setKnowledgeMounted] = useState(false);
  const [codexMounted, setCodexMounted] = useState(false);
  const [codexNavigationTarget, setCodexNavigationTarget] =
    useState<CodexNavigationTarget | null>(null);

  function navigate(nextRoute: AppRoute) {
    if (nextRoute === "knowledge") setKnowledgeMounted(true);
    if (nextRoute === "codex") setCodexMounted(true);
    setRoute(nextRoute);
  }

  function openCommittedCodexHandoff(result: CodexHandoffResult) {
    setCodexNavigationTarget({
      projectId: result.projectId,
      conversationId: result.conversationId,
      handoffId: result.handoffId,
      nonce: Date.now(),
    });
    setCodexMounted(true);
    setRoute("codex");
  }

  let content =
    route === "knowledge" ? null : (
      <TodayPage commands={commands} onOpenCodex={openCommittedCodexHandoff} />
    );
  if (route === "settings")
    content = (
      <section className="page settings-page">
        <SettingsPage commands={commands} />
      </section>
    );
  if (route === "codex") content = null;
  return (
    <main className="app-shell">
      <AppSidebar active={route} onNavigate={navigate} />
      <div
        className={
          route === "today"
            ? "workspace today-workspace"
            : route === "knowledge"
              ? "workspace knowledge-workspace-shell"
              : route === "codex"
                ? "workspace codex-workspace-shell"
                : "workspace"
        }
      >
        {content}
        {knowledgeMounted ? (
          <KnowledgePage
            commands={commands}
            hidden={route !== "knowledge"}
            onOpenCodex={openCommittedCodexHandoff}
          />
        ) : null}
        {codexMounted ? (
          <CodexPage
            commands={commands}
            hidden={route !== "codex"}
            navigationTarget={codexNavigationTarget}
          />
        ) : null}
      </div>
    </main>
  );
}

export default App;
