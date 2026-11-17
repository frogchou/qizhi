import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import './task-activity.css';
import './task-inputs.css';
import './task-delivery.css';
import { DeliveryBody } from './DeliveryBody';
import type { TaskDelivery } from './lib/delivery-presenter';
import { createTaskEventStream, type TaskStreamStatus } from './lib/task-event-stream';
import { presentTask, stateName, stateTone, type TaskPresentation } from './lib/task-presenter';
import { buildApiHeaders, type WorkflowStage } from './lib/workflow';

type Task = { id: string; goal: string; state: string; acceptanceMode?: string; createdAt: string; updatedAt: string };
type Agent = { agentId: string; displayName: string; version: string; status: string };
type ReviewRound = {
  id:string; round:number; decision:string|null; revision_number?:number;
  criteria:Array<{id:string;requirement:string;priority:string;basis:string}>;
  assessment:{items:Array<{id:string;status:string;reason:string;evidenceIds:string[]}>;reportedGaps:string[];error?:string;evidence:Array<{id:string;source:string;text:string}>};
};
type TaskDetail = {
  acceptanceRounds?:ReviewRound[];
  task: Task & Record<string, unknown>;
  planSummary?: unknown;
  delivery?: TaskDelivery;
  revisions?: Array<Record<string, unknown>>;
  plans?: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  activities: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
  inputs?: Array<Record<string, unknown>>;
  interactions?: Array<Record<string, unknown>>;
  workflow: WorkflowStage[];
};

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('mg-admin-token') ?? '');
  const [draftToken, setDraftToken] = useState(token);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [goal, setGoal] = useState('');
  const [acceptanceMode, setAcceptanceMode] = useState<'platform_auto' | 'human_review'>('platform_auto');
  const [inputFiles, setInputFiles] = useState<File[]>([]);
  const [uploadStatus, setUploadStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [stoppingId, setStoppingId] = useState('');
  const [streamStatus, setStreamStatus] = useState<TaskStreamStatus>('disconnected');
  const [now, setNow] = useState(() => Date.now());
  const [preview, setPreview] = useState<{ fileName: string; content: string } | null>(null);

  const api = useCallback(async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const hasJsonBody = options?.body !== undefined && options.body !== null && !(options.body instanceof FormData);
    const response = await fetch(path, { ...options, headers: { ...buildApiHeaders(token, hasJsonBody), ...(options?.headers ?? {}) } });
    if (response.status === 401) {
      sessionStorage.removeItem('mg-admin-token');
      setToken('');
      throw new Error('管理令牌无效或已过期。');
    }
    if (!response.ok) throw new Error((await response.text()) || `请求失败（${response.status}）`);
    return response.json() as Promise<T>;
  }, [token]);

  const updateDetail = useCallback(async (taskId: string, select = true) => {
    const next = await api<TaskDetail>(`/v1/tasks/${taskId}`);
    if (select) setSelectedId(taskId);
    setDetail(next);
    setTasks((current) => current.map((task) => task.id === taskId ? {
      ...task,
      state: typeof next.task.state === 'string' ? next.task.state : task.state,
      updatedAt: typeof next.task.updated_at === 'string' ? next.task.updated_at : task.updatedAt,
    } : task));
    return next;
  }, [api]);

  const loadDetail = useCallback(async (taskId: string) => updateDetail(taskId), [updateDetail]);

  const refresh = useCallback(async (preferredTaskId?: string) => {
    if (!token) return;
    try {
      const [nextTasks, nextAgents] = await Promise.all([api<Task[]>('/v1/tasks'), api<Agent[]>('/v1/agents')]);
      setTasks(nextTasks);
      setAgents(nextAgents);
      const nextId = preferredTaskId || selectedId || nextTasks[0]?.id;
      if (nextId) {
        await updateDetail(nextId);
      } else {
        setDetail(null);
      }
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法加载控制台数据。');
    }
  }, [api, selectedId, token, updateDetail]);

  useEffect(() => {
    if (token) void refresh();
  // Loading the signed-in console is deliberate; subsequent updates use the task SSE stream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!token || !selectedId) {
      setStreamStatus('disconnected');
      return;
    }
    let refreshTimer: number | undefined;
    const refreshSelectedTask = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void updateDetail(selectedId, false).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '无法更新任务详情。'));
      }, 120);
    };
    const stream = createTaskEventStream({
      taskId: selectedId,
      getTicket: () => api<{ ticket: string }>(`/v1/tasks/${selectedId}/events/stream-ticket`, { method: 'POST' }),
      onStatus: setStreamStatus,
      onSnapshot: refreshSelectedTask,
      onActivity: (activity) => {
        setDetail((current) => {
          if (!current || current.task.id !== selectedId) return current;
          const id = activity.id;
          const existing = current.activities ?? [];
          if (existing.some((item) => item.id === id)) return current;
          return { ...current, activities: [...existing, activity] };
        });
        refreshSelectedTask();
      },
      onError: (message) => setNotice(message),
    });
    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      stream.close();
    };
  }, [api, selectedId, token, updateDetail]);

  useEffect(() => {
    const active = detail?.task.state === 'planning' || detail?.nodes.some((node) => ['running', 'leased', 'leasing'].includes(String(node.state)));
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [detail]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim()) return;
    setLoading(true);
    try {
      const inputIds: string[] = [];
      for (const [index, file] of inputFiles.entries()) {
        setUploadStatus(`正在上传资料 ${index + 1}/${inputFiles.length}：${file.name}`);
        const form = new FormData();
        form.append('file', file, file.name);
        const uploaded = await api<{ upload: { id: string } }>('/v1/task-inputs/uploads', { method: 'POST', body: form });
        inputIds.push(uploaded.upload.id);
      }
      setUploadStatus(inputIds.length ? '正在冻结任务资料…' : '');
      const task = await api<{ taskId: string }>('/v1/tasks', { method: 'POST', body: JSON.stringify({ goal: goal.trim(), acceptanceMode, inputIds, sourceSystem:'console' }) });
      setGoal('');
      setInputFiles([]);
      setUploadStatus('');
      await refresh(task.taskId);
      setNotice(`需求已提交：${task.taskId.slice(0, 8)}${inputIds.length ? `，已冻结 ${inputIds.length} 项资料` : ''}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '需求提交失败。');
    } finally {
      setLoading(false);
      setUploadStatus('');
    }
  }

  function addInputFiles(event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.target.files ?? []);
    if (!incoming.length) return;
    setInputFiles((current) => [...current, ...incoming].filter((file, index, files) => files.findIndex((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified) === index));
    event.target.value = '';
  }

  async function approveAgent(agent: Agent) {
    try {
      await api(`/v1/agents/${agent.agentId}/versions/${agent.version}/approve`, { method: 'POST' });
      setNotice(`${agent.displayName} ${agent.version} 已批准，正在自检。`);
      await refresh(detail?.task.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '审批失败。');
    }
  }

  async function approveTask() {
    if (!detail) return;
    try {
      await api(`/v1/tasks/${detail.task.id}/approve`, { method: 'POST' });
      setNotice('已确认验收结果。');
      await refresh(detail.task.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '确认验收失败。');
    }
  }

  async function stopTask(id: string) {
    setStoppingId(id);
    try {
      await api(`/v1/tasks/${id}/stop`, { method: 'POST' });
      await refresh(id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '停止任务失败，可重试。');
    } finally { setStoppingId(''); }
  }

  async function reviewTask(decision: 'accept' | 'rework' | 'supplement') {
    if (!detail) return;
    if (decision === 'rework' && !window.confirm('将保留当前交付版本，并携带质检意见重新生成。确认继续？')) return;
    try { await api(`/v1/tasks/${detail.task.id}/review`, { method: 'POST', body: JSON.stringify({ decision, reviewId:detail.acceptanceRounds?.at(-1)?.id }) }); setNotice(decision === 'supplement' ? '已提交补查请求。' : decision === 'rework' ? '已发起返工。' : '已确认当前交付。'); await refresh(detail.task.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : '人工决定提交失败。'); }
  }

  async function artifactRequest(artifact: TaskPresentation['artifacts'][number]): Promise<Response> {
    if (!detail) throw new Error('未选择任务。');
    const response = await fetch(`/v1/tasks/${detail.task.id}/artifacts/${artifact.id}`, { headers: buildApiHeaders(token) });
    if (!response.ok) throw new Error((await response.text()) || `产物请求失败（${response.status}）`);
    return response;
  }

  async function downloadArtifact(artifact: TaskPresentation['artifacts'][number]) {
    try { const response = await artifactRequest(artifact); const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); } catch (error) { setNotice(error instanceof Error ? error.message : '产物下载失败。'); }
  }

  async function previewArtifact(artifact: TaskPresentation['artifacts'][number]) {
    try { const response = await artifactRequest(artifact); setPreview({ fileName: artifact.fileName, content: await response.text() }); } catch (error) { setNotice(error instanceof Error ? error.message : '无法预览产物。'); }
  }

  async function downloadInput(input: TaskPresentation['inputs'][number]) {
    if (!detail) return;
    try {
      const response = await fetch(`/v1/tasks/${detail.task.id}/inputs/${input.id}/download`, { headers: buildApiHeaders(token) });
      if (!response.ok) throw new Error((await response.text()) || `资料下载失败（${response.status}）`);
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = input.originalFilename || input.displayName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch (error) { setNotice(error instanceof Error ? error.message : '资料下载失败。'); }
  }

  async function respondInteraction(interactionId: string, response: Record<string, unknown>, message?: string) {
    if (!detail) return;
    try {
      await api(`/v1/tasks/${detail.task.id}/interactions/${interactionId}/respond`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ response, ...(message ? { message } : {}) }) });
      setNotice('已提交回答，正在恢复任务。');
      await refresh(detail.task.id);
    } catch (error) { setNotice(error instanceof Error ? error.message : '回答提交失败。'); }
  }

  const pendingAgents = useMemo(() => agents.filter((agent) => agent.status === 'pending_review'), [agents]);
  if (!token) return <LoginScreen draftToken={draftToken} notice={notice} onDraftTokenChange={setDraftToken} onSubmit={(event) => {
    event.preventDefault();
    sessionStorage.setItem('mg-admin-token', draftToken.trim());
    setToken(draftToken.trim());
  }} />;

  return <main className="console-shell">
    <header className="console-topbar">
      <div className="brand"><span className="brand-mark">◇</span><span>企业级 AI 智能体编排控制台</span></div>
      <nav aria-label="主导航"><a className="active">任务执行</a><a>智能体管理</a><a>工作流编排</a><a>知识与工具</a><a>运行监控</a></nav>
      <div className="top-actions"><span className="online"><i />控制面在线</span><button className="text-button" onClick={() => { sessionStorage.removeItem('mg-admin-token'); setToken(''); }}>退出</button></div>
    </header>

    <aside className="task-sidebar">
      <div className="sidebar-heading"><h1>任务列表</h1><button className="primary-button compact" onClick={() => document.getElementById('goal')?.focus()}>＋ 新建任务</button></div>
      <label className="search-placeholder"><span>⌕</span><input aria-label="筛选任务" placeholder="搜索任务（名称/编号/关键词）" /></label>
      <div className="task-filter"><span>全部任务</span><span>最近更新</span></div>
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="task-list">{tasks.map((task) => <button key={task.id} className={`task-card ${selectedId === task.id ? 'selected' : ''}`} onClick={() => void loadDetail(task.id)}>
        <strong>{task.goal}</strong><small><Status state={task.state} />{stateName(task.state)} · {formatTime(task.updatedAt)}</small>
      </button>)}{!tasks.length && <p className="empty-copy">尚无任务。提交第一条需求信号后将在此显示。</p>}</div>
      <section className="agent-review"><div className="list-label">待审批智能体</div>{pendingAgents.map((agent) => <div className="agent-card" key={`${agent.agentId}-${agent.version}`}><div><strong>{agent.displayName}</strong><small>{agent.agentId} · {agent.version}</small></div><button className="outline-button" onClick={() => void approveAgent(agent)}>批准</button></div>)}{!pendingAgents.length && <p className="empty-copy">没有待审批的智能体版本。</p>}</section>
    </aside>

    <section className="execution-main">
      <form className="new-task-form" onSubmit={submit}>
        <label htmlFor="goal">输入需求信号</label>
        <textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：基于知识库中的 438c 项目资料，生成一份项目介绍 PPT" />
        <div className="task-input-picker"><label htmlFor="task-input-files" className="outline-button">＋ 附加本任务资料</label><input id="task-input-files" type="file" multiple onChange={addInputFiles} /><span>仅当前任务可见；提交后将冻结为任务快照。</span></div>
        {inputFiles.length > 0 && <ul className="pending-input-list">{inputFiles.map((file) => <li key={`${file.name}-${file.size}-${file.lastModified}`}><span>▣</span><div><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></div><button type="button" className="text-button" disabled={loading} onClick={() => setInputFiles((current) => current.filter((item) => item !== file))}>移除</button></li>)}</ul>}
        {uploadStatus && <p className="upload-status" role="status">{uploadStatus}</p>}
        <div className="form-footer"><label className="review-choice"><input type="checkbox" checked={acceptanceMode === 'human_review'} onChange={(event) => setAcceptanceMode(event.target.checked ? 'human_review' : 'platform_auto')} />完成后由人工确认验收</label><button className="primary-button" disabled={loading}>{loading ? '中台正在接收…' : '提交需求'}</button></div>
      </form>
      {detail ? <ExecutionPanel detail={detail} stopping={stoppingId === detail.task.id} onStop={() => void stopTask(detail.task.id)} streamStatus={streamStatus} currentTime={now} onApprove={() => void reviewTask('accept')} onSupplement={() => void reviewTask('supplement')} onRework={() => void reviewTask('rework')} onRespondInteraction={(id, response, message) => void respondInteraction(id, response, message)} onDownload={(artifact) => void downloadArtifact(artifact)} onPreview={(artifact) => void previewArtifact(artifact)} onDownloadInput={(input) => void downloadInput(input)} /> : <EmptyExecution />}
    </section>
    {preview && <ArtifactPreview preview={preview} onClose={() => setPreview(null)} />}
  </main>;
}

export function ExecutionPanel({ detail, onSupplement, onStop, stopping, streamStatus = 'disconnected', currentTime = Date.now(), onApprove, onRework = () => undefined, onRespondInteraction = () => undefined, onDownload = () => undefined, onPreview = () => undefined, onDownloadInput = () => undefined }: { detail: TaskDetail; onSupplement?: () => void; onStop?: () => void; stopping?: boolean; streamStatus?: TaskStreamStatus; currentTime?: number; onApprove: () => void; onRework?: () => void; onRespondInteraction?: (interactionId: string, response: Record<string, unknown>, message?: string) => void; onDownload?: (artifact: TaskPresentation['artifacts'][number]) => void; onPreview?: (artifact: TaskPresentation['artifacts'][number]) => void; onDownloadInput?: (input: TaskPresentation['inputs'][number]) => void }) {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const presentation = presentTask(detail, currentTime);
  const directAnswer = (detail.planSummary as { mode?: string } | undefined)?.mode === 'direct_answer';
  const canStop = ['received','planning','planned','running','awaiting_user_input','awaiting_review','stopping'].includes(presentation.state);
  const revisionNumber = Number(detail.task.revision_number ?? detail.task.revisionNumber ?? 1);
  const review = detail.acceptanceRounds?.filter(round => Number(round.revision_number ?? 1) === revisionNumber).at(-1);
  const canApprove = presentation.state === 'awaiting_review';
  const hasGaps = review && (review.assessment.error || review.assessment.reportedGaps.length || review.assessment.items.some(i=>i.status!=='met'));
  const canRework = canApprove && presentation.quality?.passed === false;
  return <section className="execution-panel">
    <header className="execution-header">
      <div><div className="eyebrow">任务执行</div><h2>{presentation.title}</h2><p>任务编号：{detail.task.id.slice(0, 8)} · 创建于 {formatDate(detail.task.createdAt ?? (detail.task as Record<string, unknown>).created_at)}</p></div>
      <div className="header-actions"><span className={`status-pill ${stateTone(presentation.state)}`}><Status state={presentation.state} />{presentation.stateLabel}</span>{canStop && <button className="outline-button" disabled={stopping} onClick={onStop}>{stopping ? '正在停止…' : presentation.state === 'stopping' ? '重试停止' : '停止任务'}</button>}{canApprove && <button className="primary-button" onClick={onApprove}>{(review || canRework) ? '接受当前答复' : '确认验收'}</button>}{canApprove && hasGaps ? <button className="outline-button" onClick={onSupplement}>带证据和缺项继续补查</button> : null}{canRework && <button className="outline-button" onClick={onRework}>根据质检意见返工</button>}</div>
    </header>

    <section className="requirement-panel"><div className="section-title"><span>▣</span><h3>任务需求</h3><span className={`stream-status ${streamStatus}`}><i />实时连接 · {streamStatusName(streamStatus)}</span></div><p>{presentation.title}</p>{!directAnswer && <div className="intent-summary"><strong>中台理解</strong>{presentation.intent}<span style={{ whiteSpace: 'pre-line' }}>{presentation.summary}</span></div>}</section>

    {(presentation.answers.length > 0 || detail.delivery !== undefined) && <section className="delivery-section" aria-label="交付正文">
      <div className="section-title"><span>▤</span><h3>交付正文</h3></div>
      {presentation.answers.length ? presentation.answers.map((answer, index) => <article className="delivery-answer" key={`${answer.nodeKey}-${index}`}>
        <h4>{answer.title}</h4><DeliveryBody body={answer.body} format={answer.format} />
        {!!answer.sources?.length && <div className="delivery-sources">{answer.sources.map(source => <p key={`${source.id}-${source.url}`}><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title}</a></p>)}</div>}
      </article>) : <p className="empty-copy">{presentation.artifacts.length ? '本次交付以文件为主，请查看下方交付产物。' : '本轮暂无交付正文。'}</p>}
    </section>}

    {review && <section className="requirement-panel"><h3>按原始需求验收 · 第 {review.round} 轮</h3>
      {review.assessment.error && <p>{review.assessment.error}</p>}
      {review.criteria.map(c=>{
        const item=review.assessment.items.find(i=>i.id===c.id);
        return <div key={c.id}><strong>{c.priority==='required'?'必需':'补充'} · {c.requirement}</strong>
        <p>{item?.status==='met'?'已满足':item?.status==='missing'?'缺少资料':'待核实'} — {item?.reason}</p>
        <small>需求依据：{c.basis}</small>
        {item?.evidenceIds.map(id=>{const proof=review.assessment.evidence.find(e=>e.id===id);return proof && <details key={id}><summary>查看证据 {id}</summary><p>{proof.source}</p><p>{proof.text}</p></details>})}</div>;
      })}
      {!!review.assessment.reportedGaps.length && <details open><summary>智能体报告的资料缺项</summary><ul>{review.assessment.reportedGaps.map((g,i)=><li key={i}>{g}</li>)}</ul></details>}
      {review.decision && <p>{review.decision==='accept'?'管理员已接受本轮交付。':'管理员已要求带着本轮证据继续补查。'}</p>}
    </section>}

    {presentation.state === 'awaiting_user_input' && presentation.interactions.filter((interaction) => interaction.state === 'pending').map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} onRespond={onRespondInteraction} />)}

    <section className="flow-section"><div className="section-title"><span>⌘</span><h3>编排执行流程</h3><span className="task-runtime">{presentation.nodes.filter((node) => node.runtime === 'Codex 运行时').length ? '包含 Codex 运行时节点' : '原生运行时'}</span></div><div className="phase-flow">{presentation.stages.map((stage, index) => <PhaseStage key={stage.key} stage={stage} terminal={index === presentation.stages.length - 1} currentTime={currentTime} />)}</div></section>

    {!directAnswer && <section className="nodes-section"><div className="section-title"><span>♧</span><h3>智能体执行详情 <small>（{presentation.nodes.length} 个节点）</small></h3><button className="outline-button console-button" onClick={() => setConsoleOpen(true)}>打开实时控制台</button></div>{presentation.nodes.length ? <div className="nodes-table" role="table"><div className="node-head" role="row"><span>节点 / 智能体</span><span>能力</span><span>状态</span><span>执行时长</span><span>运行摘要</span></div>{presentation.nodes.map((node, index) => <NodeRow key={node.id || node.key} node={node} index={index} />)}</div> : <p className="empty-copy wide">{presentation.state === 'planning' ? '正在分析需求。' : '本任务没有已启动的智能体节点。'}</p>}</section>}

    <section className="activity-section"><div className="section-title"><span>◉</span><h3>实时执行时间线 <small>（{presentation.activities.length} 条活动）</small></h3></div>{presentation.activities.length ? <ol className="activity-timeline">{presentation.activities.map((activity, index) => <li key={activity.id || `${activity.kind}-${activity.occurredAt}`}><span className={`activity-dot ${stateTone(activity.state)}`} /><div className="activity-time"><time>{formatDate(activity.occurredAt)}</time><small>{timelineElapsed(presentation.activities[index - 1]?.occurredAt, activity.occurredAt)}</small></div><div className="activity-content"><strong>{activity.message}</strong><span>{sourceName(activity.source)} · {stateName(activity.state)}{activityDetail(activity.detail) ? ` · ${activityDetail(activity.detail)}` : ''}</span></div></li>)}</ol> : <p className="empty-copy wide">正在建立任务活动流；第一条后端活动会即时显示在这里。</p>}</section>

    {!directAnswer && <section className="outcomes-section"><div className="section-title"><span>▱</span><h3>资料、产物与质量结果</h3></div><div className="outcome-grid">
      <article><h4>任务资料</h4>{presentation.inputs.length ? <ul className="artifact-list">{presentation.inputs.map((input) => <li key={input.id}><span>▤</span><div><strong>{input.displayName}</strong><small>任务私有 · {input.sourceType === 'uploaded_file' ? '本地附件' : input.sourceType} · {formatBytes(input.sizeBytes)}</small></div><button className="outline-button" onClick={() => onDownloadInput(input)}>下载</button></li>)}</ul> : <p>本任务未附加私有资料。后续可从知识库或栖知选择资料附加到任务。</p>}</article>
      <article><h4>交付产物</h4>{presentation.artifacts.length ? <ArtifactList artifacts={presentation.artifacts} onDownload={onDownload} onPreview={onPreview} /> : <p>{presentation.answers.length || ['completed', 'accepted', 'awaiting_review'].includes(presentation.state) ? '本轮没有可下载的交付文件。' : `交付文件将在相应智能体完成后出现。${presentation.deliverables.length ? ` 预期交付：${presentation.deliverables.join('、')}。` : ''}`}</p>}
        {!!presentation.supportingArtifacts.length && <details className="supporting-artifacts"><summary>过程报告与参考文件（{presentation.supportingArtifacts.length}）</summary><p>执行与核验过程留档，可按需查看或下载。</p><ArtifactList artifacts={presentation.supportingArtifacts} onDownload={onDownload} onPreview={onPreview} /></details>}
      </article>
      <article><h4>质量验收</h4>{presentation.quality ? <p><Status state={presentation.quality.passed === true ? 'accepted' : presentation.quality.passed === false ? 'failed' : presentation.quality.state} />{presentation.quality.summary}</p> : <p>质量智能体会在交付物生成后，依据本任务的验收标准进行检查。</p>}{canRework && <p>质检未通过，支持保留当前版本或带着质检意见返工。</p>}{presentation.risks.length > 0 && <ul className="risk-list">{presentation.risks.map((risk) => <li key={risk}>注意：{risk}</li>)}</ul>}</article>
    </div></section>}

    <details className="debug-panel"><summary><span>〈/〉</span>开发者调试信息 <small>统一执行事件、协议事件、无敏感令牌的尝试记录和结构化结果</small></summary><div className="debug-grid"><DebugBlock title="统一执行事件" value={presentation.debug.activities} /><DebugBlock title="智能体协议事件" value={presentation.debug.events} /><DebugBlock title="执行尝试" value={presentation.debug.attempts} /><DebugBlock title="节点结果" value={presentation.debug.nodeResults} /></div></details>
    {consoleOpen && <AgentConsole entries={presentation.consoleEntries} onClose={() => setConsoleOpen(false)} />}
  </section>;
}

function ArtifactList({ artifacts, onDownload, onPreview }: { artifacts: TaskPresentation['artifacts']; onDownload: (artifact: TaskPresentation['artifacts'][number]) => void; onPreview: (artifact: TaskPresentation['artifacts'][number]) => void }) {
  return <ul className="artifact-list">{artifacts.map(artifact => <li key={artifact.id}><span>▣</span><div><strong>{artifact.fileName}</strong><small>第 {artifact.revision} 版 · {formatBytes(artifact.sizeBytes)}</small></div><button className="outline-button" onClick={() => onDownload(artifact)}>下载</button>{isPreviewable(artifact.mediaType) && <button className="text-button" onClick={() => onPreview(artifact)}>查看内容</button>}</li>)}</ul>;
}

function InteractionCard({ interaction, onRespond }: { interaction: TaskPresentation['interactions'][number]; onRespond: (interactionId: string, response: Record<string, unknown>, message?: string) => void }) {
  const [message, setMessage] = useState('');
  const [value, setValue] = useState('');
  const properties = interaction.responseSchema.properties && typeof interaction.responseSchema.properties === 'object' ? interaction.responseSchema.properties as Record<string, Record<string, unknown>> : {};
  const field = Object.keys(properties)[0];
  const choices = field && Array.isArray(properties[field]?.enum) ? properties[field].enum.map(String) : [];
  const submit = () => {
    const response = field ? { [field]: choices.length ? (value || choices[0]) : value } : { confirmed: true };
    onRespond(interaction.id, response, message || undefined);
  };
  return <section className="requirement-panel interaction-card"><div className="section-title"><span>◷</span><h3>等待你的输入</h3><span className="stream-status disconnected"><i />{interaction.source === 'agent' ? '智能体提问' : '中台提问'}</span></div><strong>{interaction.title}</strong><p>{interaction.prompt}</p>{choices.length ? <div className="form-footer">{choices.map((choice) => <label className="review-choice" key={choice}><input type="radio" name={interaction.id} checked={(value || choices[0]) === choice} onChange={() => setValue(choice)} />{choice}</label>)}</div> : field ? <textarea aria-label={interaction.title} value={value} onChange={(event) => setValue(event.target.value)} placeholder="请输入补充信息" /> : null}<textarea aria-label={`${interaction.title} 说明`} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="可选说明" /><div className="form-footer"><button className="primary-button" onClick={submit}>提交回答并恢复</button></div></section>;
}

function PhaseStage({ stage, terminal, currentTime }: { stage: WorkflowStage; terminal: boolean; currentTime: number }) {
  const tone = stateTone(stage.state);
  const liveDuration = stage.state === 'running' ? Math.max(0, currentTime - Date.parse(stage.startedAt)) : undefined;
  return <div className={`phase ${tone}`}><div className="phase-box"><span className="phase-icon">{tone === 'success' ? '✓' : tone === 'active' ? '◌' : tone === 'danger' ? '!' : tone === 'warning' ? '◷' : '○'}</span><div><strong>{stage.label}</strong><small>{stage.durationMs === undefined ? (stage.state === 'running' ? formatDuration(liveDuration ?? 0) : '等待中') : formatDuration(stage.durationMs)}</small></div></div>{!terminal && <span className="flow-arrow">→</span>}</div>;
}

function NodeRow({ node, index }: { node: TaskPresentation['nodes'][number]; index: number }) {
  return <article className="node-row" role="row"><span className="node-name"><b>{String(index + 1).padStart(2, '0')}</b><i>◇</i><span><strong>{node.title}</strong><small>{node.key}</small>{node.runtime === 'Codex 运行时' && <em>Codex 运行时</em>}</span></span><span className="capability">{capabilityName(node.capability)}</span><span className={`node-status ${stateTone(node.state)}`}><Status state={node.state} />{node.stateLabel}</span><span className="node-runtime"><strong>{node.duration}</strong><small>{node.health}</small></span><span className="node-summary"><strong>{node.reason}</strong><small>{node.summary}</small>{node.evidence.length > 0 && <small className="evidence">证据：{node.evidence.join('、')}</small>}</span></article>;
}

function AgentConsole({ entries, onClose }: { entries: TaskPresentation['consoleEntries']; onClose: () => void }) {
  return <div className="agent-console-backdrop" role="presentation" onMouseDown={onClose}><section className="agent-console" role="dialog" aria-modal="true" aria-label="智能体实时控制台" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>智能体实时控制台</strong><small>SSE 推送的统一执行事件与智能体运行输出</small></div><button className="text-button" onClick={onClose}>关闭</button></header><div className="console-output">{entries.length ? entries.map((entry) => <article key={entry.id} className={stateTone(entry.state)}><time>{formatDate(entry.occurredAt)}</time><span>[{sourceName(entry.source)}] {entry.message}</span>{entry.text && <pre>{entry.text}</pre>}</article>) : <p>尚未收到智能体输出；中台会先显示启动、首次心跳和监督事件。</p>}</div></section></div>;
}
function ArtifactPreview({ preview, onClose }: { preview: { fileName: string; content: string }; onClose: () => void }) { return <div className="agent-console-backdrop" role="presentation" onMouseDown={onClose}><section className="agent-console" role="dialog" aria-modal="true" aria-label="产物内容预览" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>{preview.fileName}</strong><small>已认证读取的文本型交付物</small></div><button className="text-button" onClick={onClose}>关闭</button></header><pre className="console-output">{preview.content}</pre></section></div>; }

export function LoginScreen({ draftToken, notice, onDraftTokenChange, onSubmit }: { draftToken: string; notice: string; onDraftTokenChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <main className="login"><section><div className="login-mark">◇</div><p className="eyebrow">企业级 AI 智能体编排控制台</p><h1>进入控制台</h1><p>输入管理员令牌以连接控制面。令牌仅保存在当前浏览器会话。</p>{notice && <p className="notice" role="status">{notice}</p>}<form onSubmit={onSubmit}><input aria-label="管理员令牌" type="password" value={draftToken} onChange={(event) => onDraftTokenChange(event.target.value)} placeholder="管理员令牌" autoFocus /><button className="primary-button">进入控制台</button></form></section></main>;
}

function EmptyExecution() { return <section className="empty-execution"><span>◇</span><h2>从一条需求信号开始</h2><p>中台会读取已经审核并就绪的智能体能力，生成可审计的任务图，并在这里展示每一个节点的实际执行状态。</p></section>; }
function Status({ state }: { state: string }) { return <i className={`status-dot ${stateTone(state)}`} aria-hidden="true" />; }
function DebugBlock({ title, value }: { title: string; value: unknown }) { return <section><h4>{title}</h4><pre>{JSON.stringify(value, null, 2)}</pre></section>; }
function capabilityName(capability: string): string { return ({ 'knowledge.retrieve': '知识检索', 'research.web': '互联网研究', 'presentation.create': '内容生成', 'quality.define_and_verify': '质量评估' } as Record<string, string>)[capability] ?? capability; }
function formatDate(value: unknown): string { const date = new Date(typeof value === 'string' ? value : ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }); }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function formatDuration(milliseconds: number): string { if (milliseconds < 1000) return `${milliseconds}ms`; const seconds = Math.floor(milliseconds / 1000); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function isPreviewable(mediaType: string): boolean { return mediaType === 'application/json' || mediaType.startsWith('text/'); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
function streamStatusName(status: TaskStreamStatus): string { return ({ connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', disconnected: '未连接' } as Record<TaskStreamStatus, string>)[status]; }
function sourceName(source: string): string { return ({ control_plane: '中台', agent: '智能体', node_manager: '节点管理服务' } as Record<string, string>)[source] ?? source; }
function timelineElapsed(previous: string | undefined, current: string): string { const milliseconds = Date.parse(current) - Date.parse(previous ?? ''); return Number.isFinite(milliseconds) && milliseconds >= 0 ? (previous ? `距上一步 ${formatDuration(milliseconds)}` : '任务开始') : ''; }
function activityDetail(detail: Record<string, unknown>): string { return ['nodeKey', 'agentId', 'agentVersion', 'eventType', 'phase', 'artifactCount', 'riskCount', 'instanceId'].flatMap((key) => detail[key] === undefined ? [] : `${key}：${String(detail[key])}`).join(' · '); }
