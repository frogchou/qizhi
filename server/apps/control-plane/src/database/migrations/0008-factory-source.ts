import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FactoryIntake1763222400000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      "ALTER TABLE tasks ADD COLUMN source_system text CHECK (source_system IN ('api','console','qizhi_desktop'))",
    );
    await q.query('CREATE INDEX idx_tasks_source_system ON tasks(source_system)');
    await q.query('CREATE INDEX idx_tasks_state_time ON tasks(state,updated_at DESC)');
    await q.query('CREATE INDEX idx_factory_tasks_created ON tasks(created_at DESC,id DESC)');
    await q.query('CREATE INDEX idx_factory_tasks_updated ON tasks(updated_at DESC,id DESC)');
    await q.query(
      'CREATE INDEX idx_factory_activity_task_kind ON task_activity_events(task_id,kind,id DESC)',
    );
    await q.query('CREATE INDEX idx_factory_attempts_created ON task_attempts(created_at DESC,id DESC)');
    await q.query('CREATE INDEX idx_factory_nodes_version ON task_nodes(agent_id,agent_version)');
    await q.query("CREATE INDEX idx_factory_agent_audit ON audit_events(id) WHERE action LIKE 'agent.%'");
  }

  async down(q: QueryRunner) {
    await q.query('DROP INDEX idx_tasks_state_time');
    await q.query(
      'DROP INDEX idx_factory_tasks_created,idx_factory_tasks_updated,idx_factory_activity_task_kind,idx_factory_attempts_created,idx_factory_nodes_version,idx_factory_agent_audit',
    );
    await q.query('ALTER TABLE tasks DROP COLUMN source_system');
  }
}
