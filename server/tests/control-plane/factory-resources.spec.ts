import { describe, expect, it, vi } from 'vitest';
import { FactoryDatasets, FactoryResourceSampler } from '../../apps/control-plane/src/factory/factory-resources';

describe('factory operator resource readings', () => {
  it('reads only configured dataset IDs, keeps missing counts unknown and coalesces concurrent probes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get('id')).toBe('permitted');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      return Response.json({ code: 0, data: [
        { id: 'permitted', name: 'Operations', document_count: 0, secret: 'server-only' },
        { id: 'outside', name: 'Outside this factory' },
      ] });
    });
    const datasets = new FactoryDatasets({ ragflowBaseUrl: 'http://ragflow.local', ragflowApiKey: 'test-secret', datasetIds: ['permitted'] }, fetcher);
    const [first, second] = await Promise.all([datasets.snapshot(), datasets.snapshot()]);
    expect(first.connection).toMatchObject({ status: 'connected', visibleCount: 1 });
    expect(first.items).toEqual([{ id: 'permitted', name: 'Operations', configured: true, documentCount: 0, chunkCount: null }]);
    expect(JSON.stringify(first)).not.toMatch(/Outside this factory|test-secret|server-only/);
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps an inaccessible knowledge catalog unknown and does not expose upstream errors', async () => {
    const datasets = new FactoryDatasets({ ragflowBaseUrl: 'http://ragflow.local', ragflowApiKey: 'test-secret', datasetIds: ['private'] },
      async () => Response.json({ code: 101, message: 'server debug detail with test-secret' }));
    const snapshot = await datasets.snapshot();
    expect(snapshot.connection).toMatchObject({ status: 'unavailable', configuredCount: 1, visibleCount: null });
    expect(JSON.stringify(snapshot)).not.toMatch(/test-secret|server debug/);
  });

  it('reports cumulative CPU microseconds and current memory bytes for the matching service only', async () => {
    const read = vi.fn(async (path: string) => {
      if (path.endsWith('/cpu.stat')) return 'user_usec 311\nusage_usec 234567\nsystem_usec 91\n';
      if (path.endsWith('/memory.current')) return '4096\n';
      throw new Error('pids controller unavailable');
    });
    const sampler = new FactoryResourceSampler(read, 'linux');
    expect(await sampler.sample('x-1', 'mg-agent-x-1', 'leased')).toMatchObject({
      available: true, source: 'cgroup_v2', cpuUsageUsec: 234567, memoryBytes: 4096, pidsCurrent: null,
    });
    expect(read.mock.calls.every(([path]) => path.startsWith('/sys/fs/cgroup/system.slice/mg-agent-x-1.service/'))).toBe(true);
    read.mockClear();
    for (const [id, unit, state] of [['x-1', '../another.unit', 'leased'], ['x-1', 'mg-agent-other', 'leased'], ['x-1', 'mg-agent-x-1', 'completed']]) {
      expect(await sampler.sample(id, unit, state)).toMatchObject({ available: false, cpuUsageUsec: null, memoryBytes: null });
    }
    expect(read).not.toHaveBeenCalled();
  });
});
