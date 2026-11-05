import { useEffect, useRef, useState } from "react";

import type {
  CodexConversation,
  CodexHandoffPreview,
  CodexHandoffResult,
  CodexHandoffSourceInput,
  CodexProject,
  QizhiCommands,
} from "../../lib/tauri";
import "./codex-dialog.css";

function SelectChevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function CodexDestinationDialog({
  commands,
  source,
  onClose,
  onCommitted,
}: {
  commands: QizhiCommands;
  source: CodexHandoffSourceInput;
  onClose: () => void;
  onCommitted: (result: CodexHandoffResult) => void;
}) {
  const [preview, setPreview] = useState<CodexHandoffPreview | null>(null);
  const [projects, setProjects] = useState<CodexProject[]>([]);
  const [conversations, setConversations] = useState<CodexConversation[]>([]);
  const [projectId, setProjectId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [confirmOriginalOnly, setConfirmOriginalOnly] = useState(false);
  const [showOriginalOnly, setShowOriginalOnly] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectGoal, setProjectGoal] = useState("");
  const requestId = useRef(createRequestId());
  const committed = useRef(false);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        if (!commands.prepareCodexHandoff || !commands.listCodexProjects) {
          throw new Error("当前版本暂不支持发送到 Codex。");
        }
        const [prepared, availableProjects] = await Promise.all([
          commands.prepareCodexHandoff({ source }),
          commands.listCodexProjects(false),
        ]);
        if (!active) return;
        setPreview(prepared);
        setProjects(availableProjects);
        const first = availableProjects.find(isUsableProject);
        setProjectId(first?.id ?? "");
      } catch (reason) {
        if (active) setError(message(reason));
      } finally {
        if (active) setLoading(false);
      }
    }
    void initialize();
    return () => {
      active = false;
    };
  }, [commands, source]);

  useEffect(() => {
    let active = true;
    setConversations([]);
    setConversationId("");
    if (!projectId || !commands.listCodexConversations) return;
    commands
      .listCodexConversations(projectId)
      .then((values) => {
        if (!active) return;
        setConversations(values);
        setConversationId(values[0]?.id ?? "");
      })
      .catch((reason) => active && setError(message(reason)));
    return () => {
      active = false;
    };
  }, [commands, projectId]);

  async function createProject() {
    const name = projectName.trim();
    if (
      !name ||
      !commands.createCodexProject ||
      !commands.createCodexConversation
    )
      return;
    setError("");
    try {
      const project = await commands.createCodexProject({
        name,
        goal: projectGoal.trim() || null,
      });
      const conversation = await commands.createCodexConversation({
        projectId: project.id,
        title: "新会话",
      });
      const nextProjects = (await commands.listCodexProjects?.(false)) ?? [
        project,
        ...projects,
      ];
      setProjects(nextProjects);
      setProjectId(project.id);
      setConversations([conversation]);
      setConversationId(conversation.id);
      setCreatingProject(false);
      setProjectName("");
      setProjectGoal("");
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function createConversation() {
    if (!projectId || !commands.createCodexConversation) return;
    setError("");
    try {
      const value = await commands.createCodexConversation({
        projectId,
        title: `新会话 ${conversations.length + 1}`,
      });
      setConversations((current) => [value, ...current]);
      setConversationId(value.id);
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function submit() {
    if (
      !preview ||
      !projectId ||
      !conversationId ||
      submitting ||
      committed.current ||
      !commands.commitCodexHandoff
    )
      return;
    setSubmitting(true);
    setError("");
    try {
      const result = await commands.commitCodexHandoff({
        sourceKind: preview.sourceKind,
        preparationId: preview.preparationId,
        requestId: requestId.current,
        projectId,
        conversationId,
        confirmLargeFiles: confirmLarge,
        confirmOriginalOnly,
      });
      if (result.status !== "ready" && result.status !== "consumed") {
        throw new Error("资料尚未准备完成，请重试。");
      }
      if (!committed.current) {
        committed.current = true;
        onCommitted(result);
      }
    } catch (reason) {
      const text = message(reason);
      if (text.includes("仅发送原文件")) setShowOriginalOnly(true);
      setError(text);
    } finally {
      setSubmitting(false);
    }
  }

  const blocked = Boolean(preview?.blockedItems.length);
  const needsLargeConfirmation = Boolean(
    preview?.requiresLargeFileConfirmation && !confirmLarge,
  );
  const canSubmit = Boolean(
    preview &&
    projectId &&
    conversationId &&
    !blocked &&
    !needsLargeConfirmation &&
    !submitting,
  );

  return (
    <div
      className="codex-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        className="codex-destination-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="发送资料到 Codex"
      >
        <header>
          <div className="codex-dialog-icon" aria-hidden="true">
            ✦
          </div>
          <div>
            <p>CODEX 工作</p>
            <h2>
              {preview
                ? `发送 ${preview.fileCount} 项资料到 Codex`
                : "准备发送资料"}
            </h2>
            <span>资料确认保存后将直接打开所选项目会话。</span>
          </div>
          <button
            type="button"
            className="codex-dialog-close"
            aria-label="关闭"
            onClick={onClose}
            disabled={submitting}
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className="codex-dialog-loading">正在核对资料…</div>
        ) : null}
        {error ? (
          <div className="codex-dialog-error" role="alert">
            {error}
          </div>
        ) : null}
        {preview ? (
          <>
            <div className="codex-handoff-preview">
              <strong>即将发送</strong>
              <span>{formatBytes(preview.totalSizeBytes)}</span>
              <ul>
                {preview.previewItems.map((item) => (
                  <li key={`${item.fileId}-${item.displayName}`}>
                    <span>{item.displayName}</span>
                    <small>{formatBytes(item.sizeBytes)}</small>
                  </li>
                ))}
              </ul>
              {preview.fileCount > preview.previewItems.length ? (
                <small>
                  另有 {preview.fileCount - preview.previewItems.length} 项资料
                </small>
              ) : null}
              {preview.blockedItems.map((item) => (
                <div
                  className="codex-preview-blocked"
                  key={`blocked-${item.fileId}`}
                >
                  不支持：{item.displayName}
                </div>
              ))}
            </div>

            <div className="codex-destination-fields">
              <label>
                Codex 项目
                <span className="codex-select-control">
                  <select
                    aria-label="Codex 项目"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="">请选择项目</option>
                    {projects.map((project) => (
                      <option
                        key={project.id}
                        value={project.id}
                        disabled={!isUsableProject(project)}
                      >
                        {project.name}
                        {isUsableProject(project) ? "" : "（正在运行）"}
                      </option>
                    ))}
                  </select>
                  <SelectChevron />
                </span>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => setCreatingProject(true)}
              >
                新建项目
              </button>
              <label>
                项目会话
                <span className="codex-select-control">
                  <select
                    aria-label="项目会话"
                    value={conversationId}
                    onChange={(event) => setConversationId(event.target.value)}
                  >
                    <option value="">请选择会话</option>
                    {conversations.map((conversation) => (
                      <option key={conversation.id} value={conversation.id}>
                        {conversation.title}
                      </option>
                    ))}
                  </select>
                  <SelectChevron />
                </span>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => void createConversation()}
                disabled={!projectId}
              >
                新建会话
              </button>
            </div>

            {preview.requiresLargeFileConfirmation ? (
              <label className="codex-confirm-row">
                <input
                  type="checkbox"
                  aria-label="确认复制大文件"
                  checked={confirmLarge}
                  onChange={(event) => setConfirmLarge(event.target.checked)}
                />
                <span>确认将超过 50 MB 的资料复制到独立项目目录</span>
              </label>
            ) : null}
            {showOriginalOnly ? (
              <label className="codex-confirm-row">
                <input
                  type="checkbox"
                  aria-label="确认仅发送原文件"
                  checked={confirmOriginalOnly}
                  onChange={(event) =>
                    setConfirmOriginalOnly(event.target.checked)
                  }
                />
                <span>确认无法解析时仅发送原文件</span>
              </label>
            ) : null}
          </>
        ) : null}

        {creatingProject ? (
          <div className="codex-inline-create">
            <strong>新建 Codex 项目</strong>
            <label>
              项目名称
              <input
                aria-label="项目名称"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                autoFocus
              />
            </label>
            <label>
              项目目标（可选）
              <textarea
                aria-label="项目目标"
                value={projectGoal}
                onChange={(event) => setProjectGoal(event.target.value)}
              />
            </label>
            <div>
              <button type="button" onClick={() => setCreatingProject(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void createProject()}
                disabled={!projectName.trim()}
              >
                创建并选择
              </button>
            </div>
          </div>
        ) : null}

        <footer className="codex-dialog-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {submitting ? "正在发送…" : "发送并打开 Codex"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function isUsableProject(project: CodexProject) {
  return project.status === "active";
}

function createRequestId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function formatBytes(value: number) {
  if (value <= 0) return "待下载";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
