import { describe, expect, it, vi } from 'vitest';

import { createTaskEventStream } from '../../apps/console/src/lib/task-event-stream';

class FakeEventSource {
  public readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public closed = false;
  public constructor(public readonly url: string) {}
  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public close() { this.closed = true; }
  public emit(type: string, data: unknown, id = '') { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>); }
}

describe('task event stream', () => {
  it('uses a short-lived ticket, reports connection state, and forwards replayable activities', async () => {
    const sources: FakeEventSource[] = [];
    const getTicket = vi.fn().mockResolvedValue({ ticket: 'ticket-one' });
    const onStatus = vi.fn();
    const onActivity = vi.fn();
    const stream = createTaskEventStream({
      taskId: 'task-438c', getTicket, onStatus, onActivity,
      eventSourceFactory: (url) => { const source = new FakeEventSource(url); sources.push(source); return source as never; },
    });

    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0].url).toContain('ticket=ticket-one');
    sources[0].onopen?.();
    sources[0].emit('activity', { id: 8, kind: 'agent_event', message: 'PPT 智能体正在生成大纲。' }, '8');

    expect(onStatus).toHaveBeenCalledWith('connected');
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ id: 8, kind: 'agent_event' }));
    stream.close();
    expect(sources[0].closed).toBe(true);
  });
});
