import { FeedbackProvider, FeedbackScope } from "./components/FeedbackNotice";
import { useState } from "react";

import "./App.css";
import {
  MaterialBasketDialog,
  MaterialBasketProvider,
} from "./features/materials/MaterialBasket";
import { FactoryWorkspace } from "./features/factory/FactoryWorkspace";
import { AssemblyPage } from "./features/factory/AssemblyPage";
import type { UpgradeEntry } from "./features/factory/assembly-model";
import type { FactoryNavigationTarget } from "./features/factory/factory-model";
import { AppSidebar, type AppRoute } from "./components/AppSidebar";
import { SettingsPage } from "./features/settings/SettingsPage";
import { KnowledgePage } from "./features/knowledge/KnowledgePage";
import { TodayPage } from "./features/today/TodayPage";
import { FileSearchPage } from "./features/file-search/FileSearchPage";
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
  const [assemblyMounted, setAssemblyMounted] = useState(false);
  const [assemblyEntry, setAssemblyEntry] = useState<{
    endpoint: string;
    target: UpgradeEntry;
    visit: number;
  }>();
  const [factoryTarget, setFactoryTarget] = useState<FactoryNavigationTarget>();
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
    setFactoryTarget(undefined);
    if (nextRoute === "assembly") setAssemblyMounted(true);
    if (nextRoute === "settings") setSettingsMounted(true);
    if (nextRoute === "knowledge") setKnowledgeMounted(true);
    if (nextRoute === "codex") setCodexMounted(true);
    setRoute(nextRoute);
  }

  function openFactory(target: FactoryNavigationTarget) {
    navigate("factory");
    setFactoryTarget(target);
  }

  function openConnectionSettings() {
    setSettingsMounted(true);
    setSettingsInitialCategory("factory");
    setRoute("settings");
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
    <FeedbackProvider>
      <MaterialBasketProvider commands={commands}>
        <main className="app-shell">
          <AppSidebar
            active={route}
            onNavigate={navigate}
            onOpenBasket={() => setBasketOpen(true)}
            showFileSearch={commands.desktopPlatform === "macos"}
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
                      : route === "assembly"
                        ? "workspace assembly-workspace-shell"
                        : "workspace"
            }
          >
            {route === "today" && (
              <FeedbackScope active={route === "today"}>
                <TodayPage
                  commands={commands}
                  onOpenCodex={openCommittedCodexHandoff}
                />
              </FeedbackScope>
            )}
            {route === "file-search" && (
              <FeedbackScope active>
                <FileSearchPage commands={commands} />
              </FeedbackScope>
            )}
            {settingsMounted && (
              <section
                className="page settings-page"
                style={route === "settings" ? undefined : { display: "none" }}
                hidden={route !== "settings"}
              >
                <FeedbackScope active={route === "settings"}>
                  <SettingsPage
                    commands={commands}
                    initialCategory={settingsInitialCategory}
                  />
                </FeedbackScope>
              </section>
            )}
            <FeedbackScope active={route === "factory"}>
              <FactoryWorkspace
                active={route === "factory"}
                initialTarget={factoryTarget}
                onOpenKnowledge={() => navigate("knowledge")}
                onOpenSettings={openConnectionSettings}
                onOpenDraft={(endpoint, target) => {
                  setAssemblyEntry((old) => ({
                    endpoint,
                    target,
                    visit: (old?.visit ?? 0) + 1,
                  }));
                  navigate("assembly");
                }}
              />
            </FeedbackScope>
            {assemblyMounted && (
              <FeedbackScope active={route === "assembly"}>
                <AssemblyPage
                  key={assemblyEntry?.visit}
                  active={route === "assembly"}
                  entry={assemblyEntry}
                  onSettings={openConnectionSettings}
                  onTask={(id, title, tab = "plan") =>
                    openFactory({ kind: "task", link: { id, title, tab } })
                  }
                  onNewTask={(scope) => openFactory({ kind: "new", scope })}
                />
              </FeedbackScope>
            )}
            {knowledgeMounted ? (
              <FeedbackScope active={route === "knowledge"}>
                <KnowledgePage
                  commands={commands}
                  hidden={route !== "knowledge"}
                  onOpenCodex={openCommittedCodexHandoff}
                />
              </FeedbackScope>
            ) : null}
            {codexMounted ? (
              <FeedbackScope active={route === "codex"}>
                <CodexPage
                  commands={commands}
                  hidden={route !== "codex"}
                  navigationTarget={codexNavigationTarget}
                />
              </FeedbackScope>
            ) : null}
          </div>
          {basketOpen && (
            <MaterialBasketDialog close={() => setBasketOpen(false)} />
          )}
        </main>
      </MaterialBasketProvider>
    </FeedbackProvider>
  );
}

export default App;
