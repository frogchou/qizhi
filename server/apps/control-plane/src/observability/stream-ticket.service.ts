import { randomBytes } from 'node:crypto';

type StreamTicket = { taskId: string; expiresAt: number };

/** Short-lived, single-use credentials for EventSource, which cannot send Bearer headers. */
export class StreamTicketService {
  private readonly tickets = new Map<string, StreamTicket>();
  private readonly ttlMs: number;

  public constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  public issue(taskId: string): { ticket: string; expiresAt: string } {
    this.clearExpired();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.tickets.set(ticket, { taskId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  public consume(ticket: string, taskId: string): boolean {
    const record = this.tickets.get(ticket);
    if (!record || record.expiresAt <= Date.now()) {
      this.tickets.delete(ticket);
      return false;
    }
    if (record.taskId !== taskId) return false;
    this.tickets.delete(ticket);
    return true;
  }

  private clearExpired(): void {
    const now = Date.now();
    for (const [ticket, record] of this.tickets) if (record.expiresAt <= now) this.tickets.delete(ticket);
  }
}
