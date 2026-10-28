import { useEffect, useState } from "react";

import { StatusNotice } from "../../components/StatusNotice";
import type { QizhiCommands, TodaySnapshot } from "../../lib/tauri";

function filename(path: string) {
  const parts = path.replace(/\//g, "\\").split("\\");
  return parts[parts.length - 1] ?? path;
}
function formatTime(epoch: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epoch));
}
function formatBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function TodayPage({ commands }: { commands: QizhiCommands }) {
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    commands
      .getTodaySnapshot()
      .then(setSnapshot)
      .catch(() =>
        setSnapshot({
          state: "unavailable",
          remediation: "无法读取本地今日记录。",
          files: [],
          clusters: [],
        }),
      );
  }, [commands]);
  async function refresh() {
    setBusy(true);
    setNotice(null);
    try {
      setSnapshot(await commands.refreshToday());
    } catch {
      setNotice("刷新未完成，请检查扫描范围和文件访问权限。");
    } finally {
      setBusy(false);
    }
  }
  async function locate() {
    if (selected === null) return;
    try {
      await commands.revealInExplorer(selected);
      setNotice("已在资源管理器中定位文件。");
    } catch {
      setNotice("无法定位该文件，它可能已移动或不再允许访问。");
    }
  }

  if (!snapshot)
    return (
      <section className="page loading">
        <p>正在读取今日文件…</p>
      </section>
    );
  if (snapshot.state === "unavailable")
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <p className="eyebrow">今日工作空间</p>
            <h1>今天产生的文件</h1>
          </div>
          <button className="button secondary" onClick={refresh}>
            重新检测
          </button>
        </header>
        <StatusNotice>{snapshot.remediation}</StatusNotice>
      </section>
    );
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">今日工作空间</p>
          <h1>今天产生的文件</h1>
          <p className="muted">按修改时间发现，内容尚未分析。</p>
        </div>
        <div className="header-actions">
          <button
            className="button secondary"
            onClick={refresh}
            disabled={busy}
          >
            {busy ? "刷新中…" : "刷新列表"}
          </button>
          <button className="button primary" disabled>
            生成今日总结
          </button>
        </div>
      </header>
      {notice ? <StatusNotice>{notice}</StatusNotice> : null}
      <div className="today-layout">
        <div className="file-panel">
          <div className="panel-title">
            <span>文件</span>
            <span>{snapshot.files.length} 项</span>
          </div>
          {snapshot.files.length === 0 ? (
            <p className="empty">今天的扫描范围内还没有发现新文件。</p>
          ) : (
            <ul className="file-list">
              {snapshot.files.map((file) => (
                <li key={file.id}>
                  <button
                    className={
                      selected === file.id ? "file-row selected" : "file-row"
                    }
                    onClick={() => setSelected(file.id)}
                  >
                    <span className="file-icon">▤</span>
                    <span className="file-name">
                      <strong>{filename(file.canonicalPath)}</strong>
                      <small>
                        {file.source} · {formatBytes(file.sizeBytes)}
                      </small>
                    </span>
                    <time>{formatTime(file.modifiedAtUtcMs)}</time>
                    <span className="tag">{file.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className="detail-panel">
          <p className="eyebrow">选择文件</p>
          <h2>
            {selected === null
              ? "查看文件上下文"
              : filename(
                  snapshot.files.find((file) => file.id === selected)
                    ?.canonicalPath ?? "",
                )}
          </h2>
          <p className="muted">
            本版本只记录安全的文件元信息，不读取或上传内容。
          </p>
          <button
            className="button secondary full"
            disabled={selected === null}
            onClick={locate}
          >
            在资源管理器中定位
          </button>
          <button className="button outline full" disabled>
            加入知识库（后续版本）
          </button>
        </aside>
      </div>
      <section className="timeline">
        <h2>今日活动</h2>
        {snapshot.clusters.map((cluster) => (
          <div className="timeline-item" key={cluster.label}>
            <span className="timeline-dot" />
            <div>
              <strong>{cluster.label}</strong>
              <p>{cluster.fileIds.length} 个文件 · 待分析</p>
            </div>
          </div>
        ))}
      </section>
    </section>
  );
}
