export type TaskStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

type EventSourceLike = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export type TaskEventStreamOptions = {
  taskId: string;
  getTicket: () => Promise<{ ticket: string }>;
  onStatus: (status: TaskStreamStatus) => void;
  onActivity: (activity: Record<string, unknown>) => void;
  onSnapshot?: (snapshot: Record<string, unknown>) => void;
  onError?: (message: string) => void;
  eventSourceFactory?: (url: string) => EventSourceLike;
  reconnectDelayMs?: number;
};

export type TaskEventStream = { close(): void };

/** Opens a ticketed SSE stream. Each reconnect obtains a fresh single-use ticket. */
export function createTaskEventStream(options: TaskEventStreamOptions): TaskEventStream {
  let closed = false;
  let source: EventSourceLike | undefined;
  let retryTimer: number | undefined;
  const delay = options.reconnectDelayMs ?? 1_000;
  const factory = options.eventSourceFactory ?? ((url: string) => new EventSource(url));

  const scheduleReconnect = () => {
    if (closed || retryTimer !== undefined) return;
    options.onStatus('reconnecting');
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void connect(false);
    }, delay);
  };

  const handle = (event: MessageEvent<string>, callback: (data: Record<string, unknown>) => void) => {
    try {
      const data: unknown = JSON.parse(event.data);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('事件内容不是对象。');
      callback(data as Record<string, unknown>);
    } catch {
      options.onError?.('收到无法识别的实时事件，已忽略该条记录。');
    }
  };

  const connect = async (initial: boolean): Promise<void> => {
    if (closed) return;
    options.onStatus(initial ? 'connecting' : 'reconnecting');
    try {
      const { ticket } = await options.getTicket();
      if (closed) return;
      const candidate = factory(`/v1/tasks/${encodeURIComponent(options.taskId)}/events/stream?ticket=${encodeURIComponent(ticket)}`);
      source = candidate;
      candidate.addEventListener('snapshot', (event) => handle(event, (snapshot) => options.onSnapshot?.(snapshot)));
      candidate.addEventListener('activity', (event) => handle(event, options.onActivity));
      candidate.onopen = () => { if (!closed && source === candidate) options.onStatus('connected'); };
      candidate.onerror = () => {
        candidate.close();
        if (source === candidate) source = undefined;
        scheduleReconnect();
      };
    } catch {
      if (!closed) {
        options.onError?.('实时监控连接暂时不可用，正在重连。');
        scheduleReconnect();
      }
    }
  };

  void connect(true);
  return {
    close() {
      closed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      source?.close();
      source = undefined;
      options.onStatus('disconnected');
    },
  };
}
