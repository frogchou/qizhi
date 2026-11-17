export type WorkflowStage = { key: string; label: string; state: string; startedAt: string; endedAt?: string; durationMs?: number; details: string[] };

export function buildApiHeaders(token: string, hasJsonBody = false): Record<string, string> {
  return {
    ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function toTimelineRows(detail: { workflow?: WorkflowStage[] }): Array<WorkflowStage & { duration: string }> {
  return (detail.workflow ?? []).map((stage) => ({ ...stage, duration: stage.durationMs === undefined ? '进行中' : stage.durationMs < 1000 ? `${stage.durationMs}ms` : `${(stage.durationMs / 1000).toFixed(1)}s` }));
}
