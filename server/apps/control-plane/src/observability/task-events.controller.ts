import { Controller, Get, Headers, Inject, Param, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AdminAuthGuard } from '../config/auth.guard.js';
import { TaskActivityPublisher, TaskActivityService, type TaskActivity } from './task-activity.service.js';
import { StreamTicketService } from './stream-ticket.service.js';

@Controller('/v1/tasks')
export class TaskEventStreamController {
  public constructor(
    @Inject(TaskActivityService) private readonly activities: TaskActivityService,
    @Inject(TaskActivityPublisher) private readonly publisher: TaskActivityPublisher,
    @Inject(StreamTicketService) private readonly tickets: StreamTicketService,
  ) {}

  @Post(':taskId/events/stream-ticket')
  @UseGuards(AdminAuthGuard)
  public issueTicket(@Param('taskId') taskId: string): { ticket: string; expiresAt: string } {
    return this.tickets.issue(taskId);
  }

  @Get(':taskId/events/stream')
  public async stream(
    @Param('taskId') taskId: string,
    @Query('ticket') ticket: string | undefined,
    @Headers('last-event-id') lastEventId: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ): Promise<void> {
    if (!ticket || !this.tickets.consume(ticket, taskId)) throw new UnauthorizedException('A valid task stream ticket is required.');
    const afterId = parseEventId(lastEventId);
    response.hijack();
    response.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let lastSent = afterId;
    let ready = false;
    let closed = false;
    const pending: TaskActivity[] = [];
    const send = (activity: TaskActivity): void => {
      if (closed || activity.id <= lastSent) return;
      lastSent = activity.id;
      response.raw.write(`id: ${activity.id}\nevent: activity\ndata: ${JSON.stringify(activity)}\n\n`);
    };
    const unsubscribe = this.publisher.subscribe(taskId, (activity) => {
      if (ready) send(activity);
      else pending.push(activity);
    });
    const cleanup = (): void => {
      closed = true;
      unsubscribe();
    };
    request.raw.once('close', cleanup);

    const historical = await this.activities.listAfter(taskId, afterId);
    response.raw.write(`event: snapshot\ndata: ${JSON.stringify({ taskId, lastEventId: afterId })}\n\n`);
    const replay = new Map<number, TaskActivity>();
    for (const activity of [...historical, ...pending]) replay.set(activity.id, activity);
    for (const activity of [...replay.values()].sort((left, right) => left.id - right.id)) send(activity);
    ready = true;
    response.raw.write(': connected\n\n');
  }
}

function parseEventId(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
