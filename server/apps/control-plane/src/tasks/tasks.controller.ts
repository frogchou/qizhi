import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AdminAuthGuard } from '../config/auth.guard.js';
import { TaskService, type IntakeSource } from './tasks.service.js';
@Controller('/v1/tasks') @UseGuards(AdminAuthGuard)
export class TasksController {
  public constructor(@Inject(TaskService) private readonly tasks: TaskService) {}
  @Post() public create(@Body() body: { goal?: string; acceptanceMode?: string; inputIds?: unknown; sourceSystem?: IntakeSource }) {
    if (!body || typeof body.goal !== 'string' || !body.goal.trim()) throw new BadRequestException('goal is required.');
    if (body.acceptanceMode !== undefined && !['platform_auto','human_review'].includes(body.acceptanceMode)) throw new BadRequestException('Unknown acceptanceMode.');
    if (body.sourceSystem !== undefined && !['api','console','qizhi_desktop'].includes(body.sourceSystem)) throw new BadRequestException('Unsupported intake channel.');
    if (body.inputIds !== undefined && (!Array.isArray(body.inputIds) || body.inputIds.some((id) => typeof id !== 'string'))) throw new BadRequestException('inputIds must be an array of strings.');
    return this.tasks.createTask(body.goal.trim(), body.acceptanceMode, body.inputIds ?? [], body.sourceSystem ?? 'api');
  }
  @Post(':taskId/stop') @HttpCode(200)
  public stop(@Param('taskId') taskId: string) { return this.tasks.stopTask(taskId); }
  @Get() public list() { return this.tasks.listTasks(); }
  @Get(':taskId/artifacts/:artifactId')
  public async download(@Param('taskId') taskId: string, @Param('artifactId') artifactId: string, @Res() response: FastifyReply): Promise<void> {
    const artifact = await this.tasks.downloadArtifact(taskId, artifactId);
    response
      .header('content-type', artifact.mediaType)
      .header('content-disposition', contentDisposition(artifact.fileName))
      .header('x-content-type-options', 'nosniff')
      .send(artifact.content);
  }
  @Get(':taskId/inputs/:inputId/download')
  public async downloadInput(@Param('taskId') taskId: string, @Param('inputId') inputId: string, @Res() response: FastifyReply): Promise<void> {
    const input = await this.tasks.downloadInput(taskId, inputId);
    response
      .header('content-type', input.mediaType)
      .header('content-disposition', contentDisposition(input.fileName))
      .header('x-content-type-options', 'nosniff')
      .send(input.content);
  }
  @Get(':taskId/interactions') public interactions(@Param('taskId') taskId: string) { return this.tasks.listInteractions(taskId); }
  @Get(':taskId/interactions/:interactionId') public interaction(@Param('taskId') taskId: string, @Param('interactionId') interactionId: string) { return this.tasks.getInteraction(taskId, interactionId); }
  @Post(':taskId/interactions/:interactionId/respond')
  public async respond(@Param('taskId') taskId: string, @Param('interactionId') interactionId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: { response?: unknown; message?: unknown; inputIds?: unknown }) {
    if (!idempotencyKey || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey)) throw new BadRequestException('Idempotency-Key is required and must be printable.');
    if (!plainObject(body.response)) throw new BadRequestException('response must be a JSON object.');
    if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 4_000 || /[\u0000]/.test(body.message))) throw new BadRequestException('message is invalid.');
    if (body.inputIds !== undefined && (!Array.isArray(body.inputIds) || body.inputIds.some((id) => typeof id !== 'string') || new Set(body.inputIds).size !== body.inputIds.length)) throw new BadRequestException('inputIds must be distinct strings.');
    return this.tasks.respondToInteraction({ taskId, interactionId, response: body.response, message: body.message, inputIds: body.inputIds as string[] | undefined, idempotencyKey });
  }
  @Post(':taskId/interactions/:interactionId/cancel') public cancelInteraction(@Param('taskId') taskId: string, @Param('interactionId') interactionId: string) { return this.tasks.cancelInteraction(taskId, interactionId); }
  @Get(':taskId') public detail(@Param('taskId') taskId: string) { return this.tasks.getTaskDetail(taskId); }
  @Post(':taskId/review') public review(@Param('taskId') taskId: string, @Headers('idempotency-key') key: string|undefined,
    @Body() body: { decision?: unknown; reviewId?:string; message?:unknown; inputIds?:unknown }) {
    if (body?.decision==='revise'||body?.decision==='amend') return this.tasks.requestRevision(taskId,{...body,decision:body.decision},key);
    if (!body || (body.decision !== 'accept' && body.decision !== 'rework' && body.decision !== 'supplement')) throw new BadRequestException('无效的验收决定。');
    return this.tasks.reviewTask(taskId, body.decision, body.reviewId);
  }
  @Post(':taskId/approve') public approve(@Param('taskId') taskId: string) { return this.tasks.approveTask(taskId); }
}

function plainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function contentDisposition(fileName: string): string {
  const safeFallback = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'artifact';
  return `attachment; filename="${safeFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
