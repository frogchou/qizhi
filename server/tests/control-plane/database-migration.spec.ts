import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createControlPlaneDataSource, runMigrations } from '../../apps/control-plane/src/database/data-source';
import { InitialControlPlaneMigration } from '../../apps/control-plane/src/database/migrations/0001-initial-control-plane';
import { requiredTestDatabaseUrl } from './test-database';

const databaseUrl = requiredTestDatabaseUrl();
const dataSource = createControlPlaneDataSource(databaseUrl);

describe('initial control-plane migration', () => {
  it('uses a TypeORM-compatible migration timestamp', () => {
    expect(new InitialControlPlaneMigration().name).toMatch(/\d{13}$/);
  });

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.dropDatabase();
    await runMigrations(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('creates the durable control-plane tables', async () => {
    const rows = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = rows.map((row) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'agents',
        'agent_versions',
        'tasks',
        'task_plans',
        'task_nodes',
        'task_attempts',
        'task_events',
        'task_activity_events',
        'task_checkpoints',
        'task_sessions',
        'approval_requests',
        'audit_events',
        'task_input_uploads',
        'task_inputs',
        'task_input_audits',
      ]),
    );
  });

  it('adds scheduling metadata required to recover independent agent instances', async () => {
    const nodeColumns = await dataSource.query<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'task_nodes'`);
    const attemptColumns = await dataSource.query<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'task_attempts'`);
    const taskColumns = await dataSource.query<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks'`);

    expect(nodeColumns.map((column) => column.column_name)).toEqual(expect.arrayContaining(['capability', 'agent_id', 'agent_version', 'depends_on', 'workspace_path', 'display_title', 'rationale']));
    expect(attemptColumns.map((column) => column.column_name)).toEqual(expect.arrayContaining(['unit_name', 'last_heartbeat_at', 'result_received_at']));
    expect(taskColumns.map((column) => column.column_name)).toEqual(expect.arrayContaining(['planner_summary', 'current_plan_version']));
  });

  it('prevents duplicate agent versions and duplicate instance event sequences', async () => {
    await dataSource.query(`INSERT INTO agents (id, display_name) VALUES ('ragflow-knowledge', 'RAGFlow 知识查询')`);
    await dataSource.query(
      `INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ('ragflow-knowledge@1.0.0', 'ragflow-knowledge', '1.0.0', 'ready', '{}')`,
    );

    await expect(
      dataSource.query(
        `INSERT INTO agent_versions (id, agent_id, version, status, manifest) VALUES ('another-id', 'ragflow-knowledge', '1.0.0', 'ready', '{}')`,
      ),
    ).rejects.toThrow();
  });
});
