import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DataSource } from 'typeorm';

import { AgentResultSchema, type AgentResult, type AgentTerminalResult, type InteractionCheckpoint } from '../../../../packages/agent-protocol/src/index.js';
import { TaskActivityService } from '../observability/task-activity.service.js';
import { OperationalLogger } from '../observability/operational-logger.js';
import { CONTROL_PLANE_DATA_SOURCE } from '../registry/registry.service.js';
import { TaskSessionService } from '../tasks/task-session.service.js';
import { TaskArtifactService } from '../tasks/task-artifact.service.js';
import { TaskInteractionService } from '../tasks/task-interaction.service.js';
import { TaskWorkspaceService } from '../tasks/task-workspace.service.js';

type AttemptRow = { revisionNumber:number; attemptId: string; attemptState: string; leaseToken: string; taskId: string; planId: string; nodeId: string; nodeKey: string; nodeWorkspace: string; attemptNumber: number; leaseExpiresAt: Date | string };
type YieldedAgentResult = Extract<AgentResult, { status: 'needs_user_input' }>;

@Injectable()
export class InstanceResultsService {
  public constructor(
    @Inject(CONTROL_PLANE_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(TaskSessionService) private readonly sessions: TaskSessionService,
    @Inject(TaskActivityService) private readonly activities: TaskActivityService,
    @Inject(OperationalLogger) private readonly logger: OperationalLogger,
    @Inject(TaskArtifactService) private readonly artifacts: TaskArtifactService,
    @Inject(TaskInteractionService) private readonly interactions: TaskInteractionService,
    @Inject(TaskWorkspaceService) private readonly workspaces: TaskWorkspaceService,
  ) {}

  public async accept(instanceId: string, input: unknown): Promise<{ accepted: true; taskId: string }> {
    const body = input as { leaseToken?: unknown; result?: unknown };
    if (!body || typeof body !== 'object' || typeof body.leaseToken !== 'string' || !Value.Check(AgentResultSchema, body.result)) throw new BadRequestException('Result callback does not match Agent Protocol v1.');
    const result = body.result as AgentResult;
    if (result.instanceId !== instanceId) throw new BadRequestException('Result instanceId does not match request path.');
    const row = await this.attempt(instanceId);
    if (!row || row.leaseToken !== body.leaseToken || new Date(row.leaseExpiresAt).getTime() <= Date.now()) throw new ForbiddenException('Instance does not hold the active lease.');
    if (row.attemptState !== 'leased') throw new ConflictException('Result was already accepted or the attempt is no longer active.');
    if (result.taskId !== row.taskId || result.taskNodeId !== row.nodeId) throw new BadRequestException('Result task identity does not match the active attempt.');
    if (result.status === 'needs_user_input') return this.acceptYielded(row, result);
    await this.verifyArtifacts(row.nodeWorkspace, result);
    await this.artifacts.archiveVerifiedArtifacts({ taskId: row.taskId, taskNodeId: row.nodeId, taskAttemptId: row.attemptId, nodeWorkspace: row.nodeWorkspace, artifacts: result.artifacts });
    await mkdir(row.nodeWorkspace, { recursive: true });
    await writeFile(join(row.nodeWorkspace, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    const nodeState = result.status === 'succeeded' ? 'completed' : 'failed';
    await this.dataSource.transaction(async (manager) => {
      const [, changed] = await manager.query("UPDATE task_attempts SET state=$2, result=$3::jsonb, result_received_at=now(), updated_at=now() WHERE id=$1 AND state='leased'", [row.attemptId, nodeState, JSON.stringify(result)]);
      if (!changed) throw new ConflictException('Attempt is no longer active.');
      await manager.query("UPDATE task_nodes SET state=$2, output=$3::jsonb, updated_at=now() WHERE id=$1", [row.nodeId, nodeState, JSON.stringify(result)]);
    });
    await this.sessions.append(row.taskId, { kind: 'node_result_received', message: result.status === 'succeeded' ? '智能体已返回可验证结果。' : '智能体报告执行失败。', detail: { nodeId: row.nodeId, artifactCount: result.artifacts.length, riskCount: result.risks.length } });
    await this.activities.append({ taskId: row.taskId, kind: 'agent_result', state: nodeState, message: result.status === 'succeeded' ? '智能体已返回可验证结果。' : '智能体报告执行失败。', detail: { instanceId, nodeId: row.nodeId, artifactCount: result.artifacts.length, riskCount: result.risks.length }, source: 'agent' });
    this.logger.info('instance_result', 'accepted', { taskId: row.taskId, nodeId: row.nodeId, instanceId, detail: { state: nodeState, artifactCount: result.artifacts.length, riskCount: result.risks.length } });
    return { accepted: true, taskId: row.taskId };
  }

  private async attempt(instanceId: string): Promise<AttemptRow | undefined> {
    const rows = await this.dataSource.query<AttemptRow[]>(`
      SELECT coalesce((p.plan->>'revisionNumber')::integer,0) AS "revisionNumber",a.id AS "attemptId", a.state AS "attemptState", a.lease_token AS "leaseToken", a.lease_expires_at AS "leaseExpiresAt", a.attempt_number AS "attemptNumber", p.id AS "planId", p.task_id AS "taskId", n.id AS "nodeId", n.node_key AS "nodeKey", n.workspace_path AS "nodeWorkspace"
      FROM task_attempts a JOIN task_nodes n ON n.id=a.task_node_id JOIN task_plans p ON p.id=n.plan_id WHERE a.instance_id=$1
    `, [instanceId]);
    return rows[0];
  }

  private async verifyArtifacts(workspace: string, result: AgentTerminalResult): Promise<void> {
    const seen = new Set<string>();
    for (const artifact of result.artifacts) {
      if (isAbsolute(artifact.path)) throw new BadRequestException('Artifact paths must be relative to the node workspace.');
      const resolved = resolve(workspace, artifact.path);
      if (relative(workspace, resolved).startsWith('..') || isAbsolute(relative(workspace, resolved))) throw new BadRequestException('Artifact path escapes the node workspace.');
      if (seen.has(resolved)) throw new BadRequestException(`Artifact ${artifact.path} was declared more than once.`);
      seen.add(resolved);
      let content: Buffer;
      try {
        const file = await lstat(resolved);
        if (file.isSymbolicLink() || !file.isFile()) throw new Error('not a regular file');
        content = await readFile(resolved);
      } catch { throw new BadRequestException(`Artifact ${artifact.path} is missing from the node workspace.`); }
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== artifact.sha256) throw new BadRequestException(`Artifact ${artifact.path} SHA-256 does not match.`);
    }
  }

  private async acceptYielded(row: AttemptRow, result: YieldedAgentResult): Promise<{ accepted: true; taskId: string }> {
    const content = await this.verifyCheckpoint(row.nodeWorkspace, result.checkpoint);
    const sealed = await this.workspaces.writeNodeCheckpoint(row.taskId, row.nodeKey, result.checkpoint.resumeKey, content,row.revisionNumber);
    const checkpoint: InteractionCheckpoint = { ...result.checkpoint, ...sealed };
    const persistedResult: YieldedAgentResult = { ...result, checkpoint };
    await mkdir(row.nodeWorkspace, { recursive: true });
    await writeFile(join(row.nodeWorkspace, 'result.json'), `${JSON.stringify(persistedResult, null, 2)}\n`, 'utf8');
    const interaction = await this.interactions.requestAgentInteraction({
      taskId: row.taskId, taskPlanId: row.planId, taskNodeId: row.nodeId, planNodeKey: row.nodeKey,
      request: result.interaction, checkpoint, requestedByAttemptId: row.attemptId, resumeRound: row.attemptNumber,
    });
    const updated = await this.dataSource.transaction(async (manager) => {
      const attempts = rowsOf(await manager.query(`UPDATE task_attempts SET state='yielded', result=$2::jsonb, result_received_at=now(), updated_at=now() WHERE id=$1 AND state='leased' RETURNING id`, [row.attemptId, JSON.stringify(persistedResult)]));
      if (!attempts[0]) return false;
      await manager.query(`UPDATE task_nodes SET state='awaiting_user_input', output=$2::jsonb, updated_at=now() WHERE id=$1`, [row.nodeId, JSON.stringify({ status: 'needs_user_input', output: { interactionId: interaction.id } })]);
      const [, active] = await manager.query(`UPDATE tasks SET state='awaiting_user_input', updated_at=now() WHERE id=$1 AND state IN ('running','planned','awaiting_user_input')`, [row.taskId]);
      if (!active) throw new ConflictException('Task is no longer active.');
      return true;
    });
    if (!updated) throw new ConflictException('Result was already accepted or the attempt is no longer active.');
    await this.sessions.append(row.taskId, { kind: 'agent_requested_user_input', message: `智能体正在等待用户输入：${interaction.title}。`, detail: { nodeId: row.nodeId, nodeKey: row.nodeKey, interactionId: interaction.id } });
    await this.activities.append({ taskId: row.taskId, kind: 'agent_requested_user_input', state: 'awaiting_user_input', message: `智能体正在等待用户输入：${interaction.title}。`, detail: { nodeId: row.nodeId, nodeKey: row.nodeKey, interactionId: interaction.id }, source: 'agent' });
    this.logger.info('instance_result', 'yielded_for_user_input', { taskId: row.taskId, nodeId: row.nodeId, instanceId: result.instanceId, detail: { interactionId: interaction.id } });
    return { accepted: true, taskId: row.taskId };
  }

  private async verifyCheckpoint(workspace: string, checkpoint: InteractionCheckpoint): Promise<Buffer> {
    if (isAbsolute(checkpoint.workspaceRelativePath)) throw new BadRequestException('Checkpoint path must be relative to the node workspace.');
    const resolved = resolve(workspace, checkpoint.workspaceRelativePath);
    if (relative(workspace, resolved).startsWith('..') || isAbsolute(relative(workspace, resolved))) throw new BadRequestException('Checkpoint path escapes the node workspace.');
    let content: Buffer;
    try {
      const file = await lstat(resolved);
      if (file.isSymbolicLink() || !file.isFile()) throw new Error('not a regular file');
      content = await readFile(resolved);
    } catch { throw new BadRequestException(`Checkpoint ${checkpoint.workspaceRelativePath} is missing from the node workspace.`); }
    if (createHash('sha256').update(content).digest('hex') !== checkpoint.sha256) throw new BadRequestException(`Checkpoint ${checkpoint.workspaceRelativePath} SHA-256 does not match.`);
    return content;
  }
}

function rowsOf(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) && Array.isArray(value[0]) ? value[0] as Array<Record<string, unknown>> : Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
