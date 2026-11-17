import { readFile } from 'node:fs/promises';
import type { TaskRuntimeConfig } from '../tasks/tasks.service.js';

type DatasetConfig = Pick<TaskRuntimeConfig, 'ragflowBaseUrl' | 'ragflowApiKey' | 'datasetIds'>;
type Dataset = { id: string; name: string; configured: true; documentCount: number | null; chunkCount: number | null };
type Connection = {
  status: 'connected' | 'unavailable' | 'unconfigured'; scope: 'configured'; message: string;
  observedAt: string; configuredCount: number; visibleCount: number | null; missingDatasetIds: string[];
};
type Catalog = { connection: Connection; items: Dataset[] };

/** The token can see more datasets than the factory is authorized to use. */
export class FactoryDatasets {
  private readonly config: DatasetConfig;
  private readonly fetcher: typeof fetch;
  private cached?: { until: number; catalog: Catalog };
  private inFlight?: Promise<Catalog>;

  constructor(config: DatasetConfig, fetcher = globalThis.fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  snapshot(): Promise<Catalog> {
    if (this.cached && Date.now() < this.cached.until) return Promise.resolve(this.cached.catalog);
    return this.inFlight ??= this.readCatalog().then(catalog => {
      this.cached = { until: Date.now() + 15_000, catalog };
      return catalog;
    }).finally(() => { this.inFlight = undefined; });
  }

  private async readCatalog(): Promise<Catalog> {
    const ids = [...new Set(this.config.datasetIds.map(id => id.trim()).filter(Boolean))];
    const connection: Connection = {
      status: 'unconfigured', scope: 'configured', message: '尚未配置 RAGFlow 服务凭据。',
      observedAt: new Date().toISOString(), configuredCount: ids.length, visibleCount: null, missingDatasetIds: [],
    };
    if (!this.config.ragflowBaseUrl || !this.config.ragflowApiKey) return { items: [], connection };
    const signal = AbortSignal.timeout(3_500);
    try {
      const endpoint = new URL(this.config.ragflowBaseUrl.replace(/\/$/, '') + '/api/v1/datasets');
      const found = new Map<string, Dataset>();
      // A single deadline and four concurrent requests bound the complete probe.
      for (let index = 0; index < Math.max(1, ids.length); index += 4) {
        const batch = ids.length ? ids.slice(index, index + 4) : [undefined];
        await Promise.all(batch.map(async id => {
          const url = new URL(endpoint);
          url.searchParams.set('page', '1');
          url.searchParams.set('page_size', '1');
          if (id) url.searchParams.set('id', id);
          const response = await this.fetcher(url, {
            method: 'GET', headers: { Authorization: 'Bearer ' + this.config.ragflowApiKey, Accept: 'application/json' },
            signal, redirect: 'error',
          });
          if (!response.ok) throw new Error('upstream HTTP error');
          const envelope: unknown = await response.json();
          if (!record(envelope) || envelope.code !== 0 || !Array.isArray(envelope.data)) throw new Error('invalid dataset response');
          if (!id) return;
          const item = envelope.data.find((value: unknown) => record(value) && value.id === id);
          if (record(item) && typeof item.name === 'string') found.set(id, {
            id, name: item.name, configured: true, documentCount: counter(item.document_count ?? item.doc_num),
            chunkCount: counter(item.chunk_count ?? item.chunk_num),
          });
        }));
      }
      const items = ids.flatMap(id => found.has(id) ? [found.get(id)!] : []);
      const missingDatasetIds = ids.filter(id => !found.has(id));
      return { items, connection: { ...connection, status: 'connected', visibleCount: items.length, missingDatasetIds,
        message: ids.length ? `本工厂配置 ${ids.length} 个知识库，本次可读取 ${items.length} 个。` : '已连接 RAGFlow，尚未为工厂指定知识库。' } };
    } catch {
      return { items: [], connection: { ...connection, status: 'unavailable', message: signal.aborted
        ? 'RAGFlow 读取超时，知识库数量暂时未知。' : 'RAGFlow 暂未返回可用目录，请检查连接和读取权限。' } };
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function counter(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** The node manager launches transient system services into system.slice on this host. */
export class FactoryResourceSampler {
  private readonly read: (path: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;

  constructor(read = (path: string) => readFile(path, 'utf8'), platform = process.platform) {
    this.read = read;
    this.platform = platform;
  }

  async sample(instanceId: string, unit: string | null, state: string) {
    const empty = { available: false, source: null, cpuUsageUsec: null, memoryBytes: null, pidsCurrent: null,
      observedAt: new Date().toISOString() };
    if (state !== 'leased' && state !== 'stopping') return { ...empty, reason: 'finished' };
    if (this.platform !== 'linux') return { ...empty, reason: 'unsupported_host' };
    if (!/^[a-zA-Z0-9-]{1,120}$/.test(instanceId)) return { ...empty, reason: 'unverified_unit' };
    const expected = 'mg-agent-' + instanceId;
    if (unit !== expected && unit !== expected + '.service') return { ...empty, reason: 'unverified_unit' };
    const path = '/sys/fs/cgroup/system.slice/' + expected + '.service/';
    const [cpu, memory, pids] = await Promise.all(['cpu.stat', 'memory.current', 'pids.current'].map(file =>
      this.read(path + file).then(value => value.trim()).catch(() => null)));
    const cpuUsageUsec = counter(cpu?.match(/^usage_usec\s+(\d+)$/m)?.[1]);
    const memoryBytes = counter(memory);
    const pidsCurrent = counter(pids);
    if ([cpuUsageUsec, memoryBytes, pidsCurrent].every(value => value === null)) return { ...empty, reason: 'cgroup_unavailable' };
    return { ...empty, available: true, source: 'cgroup_v2', cpuUsageUsec, memoryBytes, pidsCurrent, reason: null };
  }
}
