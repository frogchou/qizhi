import { useEffect, useRef, useState } from "react";

import type {
  CodexApprovalDecision,
  CodexArtifact,
  CodexConversation,
  CodexConversationHistory,
  CodexHandoffDetails,
  CodexMaterial,
  CodexMaterialSourceStatus,
  CodexProject,
  CodexRuntimeStatus,
  CodexTurnEvent,
  QizhiCommands,
} from "../../lib/tauri";
import { CodexContextPanel } from "./CodexContextPanel";
import { CodexArtifactUploadDialog } from "./CodexArtifactUploadDialog";
import { CodexConversation as ConversationPane } from "./CodexConversation";
import { CodexProjectSidebar } from "./CodexProjectSidebar";
import "./codex.css";
import "./codex-artifacts.css";
import "./codex-dialog.css";

export type CodexNavigationTarget = {
  projectId: string;
  conversationId: string;
  handoffId: string;
  nonce: number;
};

export function CodexPage({
  commands,
  hidden = false,
  navigationTarget = null,
}: {
  commands: QizhiCommands;
  hidden?: boolean;
  navigationTarget?: CodexNavigationTarget | null;
}) {
  type LiveTurnState = {
    projectId: string;
    prompt: string;
    answer: string;
    events: CodexTurnEvent[];
    running: boolean;
  };
  const [projects, setProjects] = useState<CodexProject[]>([]);
  const [conversations, setConversations] = useState<CodexConversation[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<CodexConversationHistory | null>(null);
  const [materials, setMaterials] = useState<CodexMaterial[]>([]);
  const [materialStatuses, setMaterialStatuses] = useState<
    CodexMaterialSourceStatus[]
  >([]);
  const [artifacts, setArtifacts] = useState<CodexArtifact[]>([]);
  const [pendingHandoffs, setPendingHandoffs] = useState<CodexHandoffDetails[]>(
    [],
  );
  const [artifactUploadTarget, setArtifactUploadTarget] =
    useState<CodexArtifact | null>(null);
  const [liveTurns, setLiveTurns] = useState<Record<string, LiveTurnState>>({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectGoal, setProjectGoal] = useState("");
  const [pendingLargeMaterials, setPendingLargeMaterials] = useState<{
    projectId: string;
    paths: string[];
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    kind: "project" | "conversation";
    id: string;
    name: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "project" | "conversation";
    id: string;
    name: string;
    projectId: string;
  } | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<CodexRuntimeStatus | null>(
    null,
  );
  const selectedConversationRef = useRef<string | null>(null);
  const selectedProjectRef = useRef<string | null>(null);
  const pendingHandoffRequestRef = useRef(0);

  useEffect(() => {
    void loadProjects();
    commands
      .getCodexStatus?.()
      .then(setRuntimeStatus)
      .catch(() =>
        setRuntimeStatus({
          installation: "unavailable",
          version: null,
          account: "unknown",
          sandbox: "unknown",
          server: "unavailable",
        }),
      );
  }, []);
  useEffect(() => {
    selectedProjectRef.current = projectId;
    if (projectId) void loadProject(projectId);
  }, [projectId]);
  useEffect(() => {
    selectedConversationRef.current = conversationId;
    setHistory(null);
    setPendingHandoffs([]);
    if (conversationId) {
      void loadConversation(conversationId);
      void loadPendingHandoffs(conversationId);
    }
  }, [conversationId]);
  useEffect(() => {
    if (!navigationTarget) return;
    selectedProjectRef.current = navigationTarget.projectId;
    selectedConversationRef.current = navigationTarget.conversationId;
    setProjectId(navigationTarget.projectId);
    setConversationId(navigationTarget.conversationId);
    void loadPendingHandoffs(navigationTarget.conversationId);
    void loadConversation(navigationTarget.conversationId);
  }, [navigationTarget?.nonce]);

  async function loadProjects() {
    try {
      const values = (await commands.listCodexProjects?.()) ?? [];
      setProjects(values);
      if (!selectedProjectRef.current && values[0]) setProjectId(values[0].id);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function loadProject(id: string) {
    try {
      const [nextConversations, nextMaterials, nextArtifacts, nextStatuses] =
        await Promise.all([
          commands.listCodexConversations?.(id) ?? [],
          commands.listCodexMaterials?.(id) ?? [],
          commands.listCodexArtifacts?.(id) ?? [],
          commands.inspectCodexMaterialSources?.(id) ?? [],
        ]);
      if (selectedProjectRef.current !== id) return;
      setConversations(nextConversations);
      setMaterials(nextMaterials);
      setMaterialStatuses(nextStatuses);
      setArtifacts(nextArtifacts);
      if (
        !nextConversations.some(
          (value) => value.id === selectedConversationRef.current,
        )
      )
        setConversationId(nextConversations[0]?.id ?? null);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function loadConversation(id: string) {
    try {
      const value = (await commands.readCodexConversation?.(id)) ?? null;
      if (selectedConversationRef.current === id) setHistory(value);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function loadPendingHandoffs(id: string) {
    const request = ++pendingHandoffRequestRef.current;
    try {
      const value = (await commands.listPendingCodexHandoffs?.(id)) ?? [];
      if (
        selectedConversationRef.current === id &&
        pendingHandoffRequestRef.current === request
      )
        setPendingHandoffs(value);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function dismissPending(handoffId: string, materialId: string) {
    if (!conversationId || !commands.dismissCodexHandoffItem) return;
    try {
      await commands.dismissCodexHandoffItem({ handoffId, materialId });
      await loadPendingHandoffs(conversationId);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function createProject() {
    const name = projectName.trim();
    if (!name || !commands.createCodexProject) return;
    try {
      const project = await commands.createCodexProject({
        name,
        goal: projectGoal.trim() || null,
      });
      const conversation = await commands.createCodexConversation?.({
        projectId: project.id,
        title: "新会话",
      });
      await loadProjects();
      setProjectId(project.id);
      if (conversation) setConversationId(conversation.id);
      setCreatingProject(false);
      setProjectName("");
      setProjectGoal("");
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function createConversation() {
    if (!projectId || !commands.createCodexConversation) return;
    try {
      const value = await commands.createCodexConversation({
        projectId,
        title: `新会话 ${conversations.length + 1}`,
      });
      await loadProject(projectId);
      setConversationId(value.id);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function renameSelected() {
    if (!renameTarget?.name.trim()) return;
    try {
      if (renameTarget.kind === "project") {
        await commands.renameCodexProject?.({
          id: renameTarget.id,
          name: renameTarget.name.trim(),
        });
        await loadProjects();
      } else {
        await commands.renameCodexConversation?.({
          id: renameTarget.id,
          name: renameTarget.name.trim(),
        });
        if (projectId) await loadProject(projectId);
      }
      setRenameTarget(null);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function deleteSelected() {
    const target = deleteTarget;
    if (!target) return;
    const projectLocked =
      projects.find((project) => project.id === target.projectId)?.status ===
        "running" ||
      Object.values(liveTurns).some(
        (turn) => turn.projectId === target.projectId && turn.running,
      );
    if (projectLocked) {
      setDeleteTarget(null);
      setError("任务运行期间不能删除项目或会话，请先停止任务。");
      return;
    }
    try {
      if (target.kind === "project") {
        if (!commands.archiveCodexProject) return;
        await commands.archiveCodexProject(target.id);
        const remaining = projects.filter(
          (project) => project.id !== target.id,
        );
        setProjects(remaining);
        if (selectedProjectRef.current === target.id) {
          const nextProjectId = remaining[0]?.id ?? null;
          selectedProjectRef.current = nextProjectId;
          selectedConversationRef.current = null;
          pendingHandoffRequestRef.current += 1;
          setProjectId(nextProjectId);
          setConversationId(null);
          setConversations([]);
          setHistory(null);
          setPendingHandoffs([]);
          setMaterials([]);
          setMaterialStatuses([]);
          setArtifacts([]);
        }
      } else {
        if (!commands.archiveCodexConversation) return;
        await commands.archiveCodexConversation(target.id);
        const remaining = conversations.filter(
          (conversation) => conversation.id !== target.id,
        );
        setConversations(remaining);
        if (selectedConversationRef.current === target.id) {
          const nextConversationId = remaining[0]?.id ?? null;
          selectedConversationRef.current = nextConversationId;
          pendingHandoffRequestRef.current += 1;
          setConversationId(nextConversationId);
          setHistory(null);
          setPendingHandoffs([]);
        }
      }
      setDeleteTarget(null);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function importMaterials() {
    if (
      !projectId ||
      !commands.pickCodexMaterials ||
      !commands.importCodexMaterials
    )
      return;
    const paths = await commands.pickCodexMaterials();
    if (!paths.length) return;
    await performMaterialImport(projectId, paths, false);
  }
  async function performMaterialImport(
    targetProjectId: string,
    paths: string[],
    confirmLargeFiles: boolean,
  ) {
    if (!commands.importCodexMaterials) return;
    setImporting(true);
    try {
      const nextMaterials = await commands.importCodexMaterials({
        projectId: targetProjectId,
        paths,
        confirmLargeFiles,
      });
      if (selectedProjectRef.current === targetProjectId) {
        setMaterials(nextMaterials);
        setMaterialStatuses(
          (await commands.inspectCodexMaterialSources?.(targetProjectId)) ?? [],
        );
      }
      setPendingLargeMaterials(null);
    } catch (reason) {
      const text = message(reason);
      if (text.includes("需要确认复制超过 50 MB")) {
        if (selectedProjectRef.current === targetProjectId)
          setPendingLargeMaterials({ projectId: targetProjectId, paths });
      } else if (selectedProjectRef.current === targetProjectId) {
        setError(text);
      }
    } finally {
      setImporting(false);
    }
  }
  async function removeMaterial(id: string) {
    const targetProjectId = projectId;
    if (
      targetProjectId &&
      window.confirm(
        "从这个 Codex 项目中移除该资料？已有历史任务仍保留当时使用的版本。",
      )
    ) {
      try {
        const nextMaterials =
          (await commands.removeCodexMaterial?.(targetProjectId, id)) ??
          materials;
        if (selectedProjectRef.current === targetProjectId) {
          setMaterials(nextMaterials);
          setMaterialStatuses((current) =>
            current.filter((status) => status.materialId !== id),
          );
        }
      } catch (reason) {
        if (selectedProjectRef.current === targetProjectId)
          setError(message(reason));
      }
    }
  }
  async function refreshMaterial(id: string) {
    const targetProjectId = projectId;
    if (
      !targetProjectId ||
      !commands.refreshCodexMaterial ||
      !window.confirm(
        "从原始来源创建一个新的资料版本？历史任务仍使用原来的快照。",
      )
    )
      return;
    try {
      const nextMaterials = await commands.refreshCodexMaterial(
        targetProjectId,
        id,
      );
      const nextStatuses =
        (await commands.inspectCodexMaterialSources?.(targetProjectId)) ?? [];
      if (selectedProjectRef.current === targetProjectId) {
        setMaterials(nextMaterials);
        setMaterialStatuses(nextStatuses);
      }
    } catch (reason) {
      if (selectedProjectRef.current === targetProjectId)
        setError(message(reason));
    }
  }
  async function revealMaterialSource(id: string) {
    if (!projectId || !commands.revealCodexMaterialSource) return;
    try {
      await commands.revealCodexMaterialSource(projectId, id);
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function send(prompt: string) {
    if (!projectId || !conversationId || !commands.startCodexTurn) return;
    const targetProjectId = projectId;
    const targetConversationId = conversationId;
    const targetHandoffIds = pendingHandoffs
      .filter((handoff) => handoff.items.some((item) => item.state === "ready"))
      .map((handoff) => handoff.handoff.id);
    setLiveTurns((current) => ({
      ...current,
      [targetConversationId]: {
        projectId: targetProjectId,
        prompt,
        answer: "",
        events: [],
        running: true,
      },
    }));
    setError("");
    try {
      await commands.startCodexTurn(
        {
          projectId: targetProjectId,
          conversationId: targetConversationId,
          prompt,
          handoffIds: targetHandoffIds,
        },
        (event) => {
          setLiveTurns((current) => {
            const active = current[targetConversationId];
            if (!active) return current;
            return {
              ...current,
              [targetConversationId]: {
                ...active,
                events: [...active.events, event],
                answer:
                  event.type === "messageDelta"
                    ? active.answer + event.delta
                    : active.answer,
                running: event.type === "completed" ? false : active.running,
              },
            };
          });
          if (event.type === "completed") {
            if (selectedProjectRef.current === targetProjectId)
              setArtifacts(event.artifacts);
            void loadProject(targetProjectId);
            window.setTimeout(() => {
              if (selectedConversationRef.current === targetConversationId)
                void loadConversation(targetConversationId);
              setLiveTurns((current) => {
                const next = { ...current };
                delete next[targetConversationId];
                return next;
              });
            }, 80);
          }
        },
      );
      if (selectedConversationRef.current === targetConversationId) {
        setPendingHandoffs((current) =>
          current.filter(
            (handoff) => !targetHandoffIds.includes(handoff.handoff.id),
          ),
        );
        void loadPendingHandoffs(targetConversationId);
      }
    } catch (reason) {
      setLiveTurns((current) => {
        const next = { ...current };
        delete next[targetConversationId];
        return next;
      });
      setError(message(reason));
    }
  }
  async function stop() {
    if (projectId) await commands.interruptCodexTurn?.(projectId);
  }
  async function resolveApproval(
    requestId: string,
    decision: CodexApprovalDecision,
  ) {
    await commands.resolveCodexApproval?.(requestId, decision);
    if (!conversationId) return;
    setLiveTurns((current) => {
      const active = current[conversationId];
      if (!active) return current;
      return {
        ...current,
        [conversationId]: {
          ...active,
          events: active.events.filter(
            (event) =>
              event.type !== "approvalRequested" ||
              event.requestId !== requestId,
          ),
        },
      };
    });
  }

  const selectedProject = projects.find((value) => value.id === projectId);
  const selectedConversation = conversations.find(
    (value) => value.id === conversationId,
  );
  const currentLive = conversationId ? liveTurns[conversationId] : undefined;
  const projectHasRunningTurn =
    selectedProject?.status === "running" ||
    Object.values(liveTurns).some(
      (turn) => turn.projectId === projectId && turn.running,
    );
  const runtimeUnavailable = commands.getCodexStatus
    ? runtimeStatus?.installation !== "ready" ||
      runtimeStatus.account !== "ready"
    : false;
  const runtimeMessage = runtimeUnavailable
    ? runtimeStatus?.installation === "ready"
      ? "请先在本机 Codex 中完成登录，然后重新进入 Codex 工作。"
      : "未检测到本机 Codex，请先安装并登录 Codex 后使用此功能。"
    : undefined;
  return (
    <section className="codex-page" hidden={hidden} aria-hidden={hidden}>
      <CodexProjectSidebar
        projects={projects}
        conversations={conversations}
        selectedProjectId={projectId}
        selectedConversationId={conversationId}
        onSelectProject={setProjectId}
        onSelectConversation={setConversationId}
        onCreateProject={() => setCreatingProject(true)}
        onCreateConversation={() => void createConversation()}
        onRenameProject={(project) =>
          setRenameTarget({
            kind: "project",
            id: project.id,
            name: project.name,
          })
        }
        onRenameConversation={(conversation) =>
          setRenameTarget({
            kind: "conversation",
            id: conversation.id,
            name: conversation.title,
          })
        }
        onDeleteProject={(project) =>
          setDeleteTarget({
            kind: "project",
            id: project.id,
            name: project.name,
            projectId: project.id,
          })
        }
        onDeleteConversation={(conversation) =>
          setDeleteTarget({
            kind: "conversation",
            id: conversation.id,
            name: conversation.title,
            projectId: conversation.projectId,
          })
        }
        lockedProjectId={projectHasRunningTurn ? (projectId ?? null) : null}
      />
      <main className="codex-main">
        <header className="codex-work-header">
          <div>
            <p>CODEX 工作</p>
            <h1>
              {selectedConversation?.title ||
                selectedProject?.name ||
                "创建第一个项目"}
            </h1>
            <span>{selectedProject?.name || "独立资料与生成目录"}</span>
          </div>
          <div
            className={`codex-runtime-chip${runtimeUnavailable ? " unavailable" : ""}`}
          >
            <i />
            {runtimeUnavailable ? "Codex 未就绪" : "本机 Codex"}
          </div>
        </header>
        {runtimeMessage ? (
          <div className="codex-runtime-notice" role="status">
            {runtimeMessage}
          </div>
        ) : null}
        {projects.length ? (
          <ConversationPane
            history={history}
            livePrompt={currentLive?.prompt ?? ""}
            liveAnswer={currentLive?.answer ?? ""}
            events={currentLive?.events ?? []}
            running={currentLive?.running ?? projectHasRunningTurn}
            disabledReason={runtimeMessage}
            onSend={send}
            onStop={stop}
            onResolveApproval={resolveApproval}
            pendingHandoffs={pendingHandoffs}
            onDismissPending={dismissPending}
          />
        ) : (
          <div className="codex-first-project">
            <span>✦</span>
            <h2>建立一个 Codex 项目</h2>
            <p>把资料、连续会话和生成文件集中在独立工作空间中。</p>
            <button type="button" onClick={() => setCreatingProject(true)}>
              创建项目
            </button>
          </div>
        )}
        {error ? (
          <div className="codex-toast" role="alert">
            {error}
            <button type="button" onClick={() => setError("")}>
              ×
            </button>
          </div>
        ) : null}
      </main>
      <CodexContextPanel
        materials={materials}
        materialStatuses={materialStatuses}
        artifacts={artifacts}
        importing={importing}
        locked={projectHasRunningTurn}
        onImport={() => void importMaterials()}
        onRemoveMaterial={(id) => void removeMaterial(id)}
        onRefreshMaterial={(id) => void refreshMaterial(id)}
        onRevealMaterialSource={(id) => void revealMaterialSource(id)}
        onOpenArtifact={(path) =>
          projectId && void commands.openCodexArtifact?.(projectId, path)
        }
        onRevealArtifact={(path) =>
          projectId && void commands.revealCodexArtifact?.(projectId, path)
        }
        onExportArtifact={(path) =>
          projectId && void commands.exportCodexArtifact?.(projectId, path)
        }
        onUploadArtifact={setArtifactUploadTarget}
      />
      {artifactUploadTarget ? (
        <CodexArtifactUploadDialog
          artifact={artifactUploadTarget}
          commands={commands}
          onClose={() => setArtifactUploadTarget(null)}
          onUploaded={() => setError("")}
        />
      ) : null}
      {creatingProject ? (
        <div
          className="codex-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreatingProject(false);
          }}
        >
          <form
            className="codex-project-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <div className="codex-dialog-icon">✦</div>
            <div>
              <p>新建工作空间</p>
              <h2>创建 Codex 项目</h2>
              <span>项目中的资料、会话和生成物会持续保留。</span>
            </div>
            <label>
              项目名称
              <input
                autoFocus
                value={projectName}
                onChange={(event) => setProjectName(event.currentTarget.value)}
                placeholder="例如：年度经营分析"
              />
            </label>
            <label>
              项目目标（可选）
              <textarea
                value={projectGoal}
                onChange={(event) => setProjectGoal(event.currentTarget.value)}
                placeholder="告诉 Codex 这个项目要完成什么"
              />
            </label>
            <div className="codex-dialog-actions">
              <button type="button" onClick={() => setCreatingProject(false)}>
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!projectName.trim()}
              >
                创建项目
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {pendingLargeMaterials ? (
        <div className="codex-dialog-backdrop" role="presentation">
          <section
            className="codex-project-dialog codex-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-large-material-title"
          >
            <div className="codex-dialog-icon">⇧</div>
            <div>
              <p>大文件资料</p>
              <h2 id="codex-large-material-title">确认复制到项目</h2>
              <span>
                选择中包含超过 50 MB
                的文件。栖知会复制安全快照，可能占用较多磁盘空间。
              </span>
            </div>
            <div className="codex-dialog-actions">
              <button
                type="button"
                onClick={() => setPendingLargeMaterials(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void performMaterialImport(
                    pendingLargeMaterials.projectId,
                    pendingLargeMaterials.paths,
                    true,
                  )
                }
              >
                确认复制
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {renameTarget ? (
        <div
          className="codex-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRenameTarget(null);
          }}
        >
          <form
            className="codex-project-dialog codex-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void renameSelected();
            }}
          >
            <div className="codex-dialog-icon">✎</div>
            <div>
              <p>整理工作空间</p>
              <h2>重命名{renameTarget.kind === "project" ? "项目" : "会话"}</h2>
            </div>
            <label>
              新名称
              <input
                autoFocus
                value={renameTarget.name}
                onChange={(event) =>
                  setRenameTarget({
                    ...renameTarget,
                    name: event.currentTarget.value,
                  })
                }
              />
            </label>
            <div className="codex-dialog-actions">
              <button type="button" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!renameTarget.name.trim()}
              >
                保存名称
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {deleteTarget ? (
        <div
          className="codex-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDeleteTarget(null);
          }}
        >
          <section
            aria-label={
              deleteTarget.kind === "project"
                ? "删除 Codex 项目"
                : "删除 Codex 会话"
            }
            aria-modal="true"
            className="codex-project-dialog codex-confirm-dialog codex-delete-dialog"
            role="dialog"
          >
            <div className="codex-dialog-icon">−</div>
            <div>
              <p>整理工作空间</p>
              <h2>
                删除{deleteTarget.kind === "project" ? "项目" : "会话"}“
                {deleteTarget.name}”？
              </h2>
              <span>
                将从当前工作空间隐藏，历史记录、资料快照和生成文件仍会安全保留。
              </span>
            </div>
            <div className="codex-dialog-actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>
                取消删除
              </button>
              <button
                className="danger"
                onClick={() => void deleteSelected()}
                type="button"
              >
                确认删除{deleteTarget.kind === "project" ? "项目" : "会话"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
