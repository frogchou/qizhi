import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { CONTROL_PLANE_DATA_SOURCE } from '../registry/registry.service.js';
import { TASK_RUNTIME_CONFIG, type TaskRuntimeConfig } from '../tasks/tasks.service.js';
import { FactoryChanges, formatCursor, parseCursor } from './factory-changes.js';
import { localAssetCounts, overview, overviewFacts } from './factory-overview.js';
import { agents, deliveries, monitor, quality, runtimeInventory, runtimeJobs, sources, tasks } from './factory-projections.js';
import { FactoryDatasets, FactoryResourceSampler } from './factory-resources.js';
import { integer, page, type FactoryQuery } from './factory-query.js';

const lists = { tasks, agents, quality, sources, deliveries, monitor };

@Injectable()
export class FactoryService {
  private readonly datasets: FactoryDatasets;
  private readonly sampler = new FactoryResourceSampler();
  private readonly changes: FactoryChanges;

  constructor(@Inject(CONTROL_PLANE_DATA_SOURCE) private readonly db: DataSource, @Inject(TASK_RUNTIME_CONFIG) config: TaskRuntimeConfig) {
    this.datasets = new FactoryDatasets(config);
    this.changes = new FactoryChanges(db);
  }

  async overview() {
    const [watermarks, catalog] = await Promise.all([this.changes.watermark(), this.datasets.snapshot()]);
    const facts = await this.db.transaction('REPEATABLE READ', overviewFacts);
    return overview(facts, catalog.connection, formatCursor(watermarks));
  }

  list(name: keyof typeof lists, query: FactoryQuery) {
    const paging = page(query);
    return this.db.transaction('REPEATABLE READ', async db => lists[name](db,query,paging));
  }

  async assets(query: FactoryQuery) {
    const paging = page(query);
    const [catalog, assets] = await Promise.all([this.datasets.snapshot(),localAssetCounts(this.db.manager)]);
    return { items: catalog.items.slice(paging.offset, paging.offset+paging.limit), total: catalog.connection.visibleCount,
      ...paging, connection: catalog.connection, metrics: { inputCount: assets.inputs, artifactCount: assets.artifacts, sessionCount: assets.sessions },
      observedAt: catalog.connection.observedAt };
  }

  async runtimes(query: FactoryQuery) {
    const paging = page(query);
    const { jobs, inventory } = await this.db.transaction('REPEATABLE READ', async db => ({
      jobs: await runtimeJobs(db,query,paging), inventory: await runtimeInventory(db),
    }));
    const items = await Promise.all(jobs.items.map(async job => ({
      ...job, metrics: await this.sampler.sample(job.instanceId,job.unitName,job.state),
    })));
    return { ...jobs, inventory, items };
  }

  changesAfter(query: FactoryQuery, signal?: AbortSignal) {
    return this.changes.read(parseCursor(query.after), integer(query.waitMs, 0, 0, 25_000, 'waitMs'), signal);
  }
}
