import { useEffect, useRef, useState } from "react";

import type { CodexConversation, CodexProject } from "../../lib/tauri";

function WorkspaceActionMenu({
  triggerLabel,
  renameLabel,
  deleteLabel,
  deleteDisabled,
  onRename,
  onDelete,
}: {
  triggerLabel: string;
  renameLabel: string;
  deleteLabel: string;
  deleteDisabled: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className={
        open ? "codex-workspace-actions open" : "codex-workspace-actions"
      }
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={triggerLabel}
        className="codex-action-trigger"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle cx="4" cy="10" r="1.35" />
          <circle cx="10" cy="10" r="1.35" />
          <circle cx="16" cy="10" r="1.35" />
        </svg>
      </button>
      {open ? (
        <div
          aria-label={triggerLabel}
          className="codex-action-menu"
          role="menu"
        >
          <button
            onClick={() => {
              setOpen(false);
              onRename();
            }}
            role="menuitem"
            type="button"
          >
            {renameLabel}
          </button>
          <button
            className="danger"
            disabled={deleteDisabled}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            role="menuitem"
            title={deleteDisabled ? "任务运行中，暂时不能删除" : undefined}
            type="button"
          >
            {deleteLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CodexProjectSidebar({
  projects,
  conversations,
  selectedProjectId,
  selectedConversationId,
  onSelectProject,
  onSelectConversation,
  onCreateProject,
  onCreateConversation,
  onRenameProject,
  onRenameConversation,
  onDeleteProject,
  onDeleteConversation,
  lockedProjectId,
}: {
  projects: CodexProject[];
  conversations: CodexConversation[];
  selectedProjectId: string | null;
  selectedConversationId: string | null;
  onSelectProject: (id: string) => void;
  onSelectConversation: (id: string) => void;
  onCreateProject: () => void;
  onCreateConversation: () => void;
  onRenameProject: (project: CodexProject) => void;
  onRenameConversation: (conversation: CodexConversation) => void;
  onDeleteProject: (project: CodexProject) => void;
  onDeleteConversation: (conversation: CodexConversation) => void;
  lockedProjectId: string | null;
}) {
  return (
    <aside className="codex-project-sidebar">
      <div className="codex-side-heading">
        <div>
          <span>工作空间</span>
          <strong>Codex 项目</strong>
        </div>
        <button
          type="button"
          onClick={onCreateProject}
          aria-label="新建 Codex 项目"
        >
          ＋
        </button>
      </div>
      <div className="codex-project-list">
        {projects.map((project) => (
          <section
            key={project.id}
            className={
              project.id === selectedProjectId
                ? "codex-project active"
                : "codex-project"
            }
          >
            {(() => {
              const deletionLocked =
                project.status === "running" || project.id === lockedProjectId;
              return (
                <>
                  <div className="codex-project-row">
                    <button
                      type="button"
                      className="codex-project-button"
                      onClick={() => onSelectProject(project.id)}
                    >
                      <span className="codex-folder-icon">◇</span>
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.goal || "独立任务工作区"}</small>
                      </span>
                    </button>
                    <WorkspaceActionMenu
                      deleteDisabled={deletionLocked}
                      deleteLabel={`删除项目 ${project.name}`}
                      onDelete={() => onDeleteProject(project)}
                      onRename={() => onRenameProject(project)}
                      renameLabel={`重命名项目 ${project.name}`}
                      triggerLabel={`项目操作 ${project.name}`}
                    />
                  </div>
                  {project.id === selectedProjectId ? (
                    <div className="codex-conversation-list">
                      {conversations.map((conversation) => (
                        <div
                          key={conversation.id}
                          className={
                            conversation.id === selectedConversationId
                              ? "codex-conversation-row active"
                              : "codex-conversation-row"
                          }
                        >
                          <button
                            type="button"
                            onClick={() =>
                              onSelectConversation(conversation.id)
                            }
                          >
                            <span>⌁</span>
                            <span>{conversation.title}</span>
                            {conversation.status === "running" ? <i /> : null}
                          </button>
                          <WorkspaceActionMenu
                            deleteDisabled={deletionLocked}
                            deleteLabel={`删除会话 ${conversation.title}`}
                            onDelete={() => onDeleteConversation(conversation)}
                            onRename={() => onRenameConversation(conversation)}
                            renameLabel={`重命名会话 ${conversation.title}`}
                            triggerLabel={`会话操作 ${conversation.title}`}
                          />
                        </div>
                      ))}
                      <button
                        type="button"
                        className="new-conversation"
                        onClick={onCreateConversation}
                      >
                        ＋ 新会话
                      </button>
                    </div>
                  ) : null}
                </>
              );
            })()}
          </section>
        ))}
      </div>
    </aside>
  );
}
