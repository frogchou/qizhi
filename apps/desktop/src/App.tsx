import { useState } from "react";

import "./App.css";
import {
  MaterialBasketDialog,
  MaterialBasketProvider,
} from "./features/materials/MaterialBasket";
import { FactoryWorkspace } from "./features/factory/FactoryWorkspace";
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
  const [basketOpen, setBasketOpen] = useState(false);
  const [route, setRoute] = useState<AppRoute>("factory");
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<
    "factory" | undefined
  >();
  const [knowledgeMounted, setKnowledgeMounted] = useState(false);
  const [codexMounted, setCodexMounted] = useState(false);
  const [codexNavigationTarget, setCodexNavigationTarget] =
    useState<CodexNavigationTarget | null>(null);

  function navigate(nextRoute: AppRoute) {
    setSettingsInitialCategory(undefined);
    if (nextRoute === "settings") setSettingsMounted(true);
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

  return (
    <MaterialBasketProvider commands={commands}>
      <main className="app-shell">
        <AppSidebar
          active={route}
          onNavigate={navigate}
          onOpenBasket={() => setBasketOpen(true)}
        />
        <div
          className={
            route === "today"
              ? "workspace today-workspace"
              : route === "knowledge"
                ? "workspace knowledge-workspace-shell"
                : route === "codex"
                  ? "workspace codex-workspace-shell"
                  : route === "factory"
                    ? "workspace factory-workspace"
                    : "workspace"
          }
        >
          {route === "today" && (
            <TodayPage
              commands={commands}
              onOpenCodex={openCommittedCodexHandoff}
            />
          )}
          {settingsMounted && (
            <section
              className="page settings-page"
              style={route === "settings" ? undefined : { display: "none" }}
              hidden={route !== "settings"}
            >
              <SettingsPage
                commands={commands}
                initialCategory={settingsInitialCategory}
              />
            </section>
          )}
          <FactoryWorkspace
            active={route === "factory"}
            onOpenKnowledge={() => navigate("knowledge")}
            onOpenSettings={() => {
              setSettingsMounted(true);
              setSettingsInitialCategory("factory");
              setRoute("settings");
            }}
          />
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
        {basketOpen && (
          <MaterialBasketDialog close={() => setBasketOpen(false)} />
        )}
      </main>
    </MaterialBasketProvider>
  );
}

export default App;
