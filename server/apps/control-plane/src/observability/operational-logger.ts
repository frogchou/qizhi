export type OperationalLogContext = {
  taskId?: string;
  nodeId?: string;
  instanceId?: string;
  agentId?: string;
  version?: string;
  detail?: Record<string, unknown>;
};

type LoggerOptions = { write?: (line: string) => void; now?: () => Date };

/** JSON logs for journald: correlated, bounded and safe to retain. */
export class OperationalLogger {
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  public constructor(options: LoggerOptions = {}) {
    this.write = options.write ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  public info(component: string, event: string, context: OperationalLogContext = {}): void { this.emit('info', component, event, context); }
  public warn(component: string, event: string, context: OperationalLogContext = {}): void { this.emit('warn', component, event, context); }
  public error(component: string, event: string, context: OperationalLogContext = {}): void { this.emit('error', component, event, context); }

  private emit(level: 'info' | 'warn' | 'error', component: string, event: string, context: OperationalLogContext): void {
    this.write(JSON.stringify({ timestamp: this.now().toISOString(), level, component, event, ...compact(context), detail: redact(context.detail ?? {}) }));
  }
}
function compact(context: OperationalLogContext): Omit<OperationalLogContext, 'detail'> {
  return Object.fromEntries(Object.entries({ taskId: context.taskId, nodeId: context.nodeId, instanceId: context.instanceId, agentId: context.agentId, version: context.version }).filter(([, value]) => value !== undefined));
}
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return value.length <= 2_000 ? value : `${value.slice(0, 1_999)}…`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, /(?:api[_-]?key|authorization|password|secret|token|cookie)/i.test(key) ? '[REDACTED]' : redact(nested, depth + 1)]));
}
