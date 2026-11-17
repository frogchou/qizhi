import { describe, expect, it, vi } from 'vitest';

import { TaskEventStreamController } from '../../apps/control-plane/src/observability/task-events.controller';
import { StreamTicketService } from '../../apps/control-plane/src/observability/stream-ticket.service';

describe('task stream tickets', () => {
  it('scopes a one-time ticket to one task and refuses reuse or a different task', () => {
    const tickets = new StreamTicketService({ ttlMs: 60_000 });
    const { ticket } = tickets.issue('task-a');

    expect(tickets.consume(ticket, 'task-b')).toBe(false);
    expect(tickets.consume(ticket, 'task-a')).toBe(true);
    expect(tickets.consume(ticket, 'task-a')).toBe(false);
  });

  it('writes a snapshot and ordered replay to an SSE response before subscribing for live activity', async () => {
    const tickets = new StreamTicketService({ ttlMs: 60_000 });
    const activities = {
      listAfter: vi.fn().mockResolvedValue([
        { id: 2, taskId: 'task-a', kind: 'planning_started', state: 'planning', message: '正在分析', detail: {}, source: 'control_plane', occurredAt: '2026-11-11T10:00:00.000Z' },
        { id: 3, taskId: 'task-a', kind: 'planning_completed', state: 'planned', message: '已编排', detail: { nodeCount: 3 }, source: 'control_plane', occurredAt: '2026-11-11T10:00:01.000Z' },
      ]),
    };
    const publisher = { subscribe: vi.fn().mockReturnValue(() => undefined) };
    const writes: string[] = [];
    const request = { headers: {}, raw: { once: vi.fn() } };
    const response = { hijack: vi.fn(), raw: { writeHead: vi.fn(), write: vi.fn((chunk: string) => writes.push(chunk)) } };
    const { ticket } = tickets.issue('task-a');
    const controller = new TaskEventStreamController(activities as any, publisher as any, tickets);

    await controller.stream('task-a', ticket, undefined, request as any, response as any);

    expect((response.raw.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][1]['content-type']).toContain('text/event-stream');
    expect(writes.join('')).toContain('event: snapshot');
    expect(writes.join('')).toContain('id: 2');
    expect(writes.join('')).toContain('id: 3');
    expect(publisher.subscribe).toHaveBeenCalledWith('task-a', expect.any(Function));
  });
});
