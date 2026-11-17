import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds facts needed to schedule, observe and resume independently launched agents. */
export class AgentOrchestrationMigration implements MigrationInterface {
  name = 'AgentOrchestrationMigration1762821600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE tasks ADD COLUMN planner_summary jsonb`);
    await queryRunner.query(`ALTER TABLE tasks ADD COLUMN current_plan_version integer`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN capability text`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN agent_id text`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN agent_version text`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN depends_on jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN workspace_path text`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN display_title text`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN rationale text`);
    await queryRunner.query(`ALTER TABLE task_attempts ADD COLUMN unit_name text`);
    await queryRunner.query(`ALTER TABLE task_attempts ADD COLUMN last_heartbeat_at timestamptz`);
    await queryRunner.query(`ALTER TABLE task_attempts ADD COLUMN result_received_at timestamptz`);
    await queryRunner.query(`CREATE TABLE task_sessions (
      id bigserial PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id),
      kind text NOT NULL,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX task_sessions_task_id_occurred_at_idx ON task_sessions(task_id, occurred_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS task_sessions`);
    await queryRunner.query(`ALTER TABLE task_attempts DROP COLUMN IF EXISTS result_received_at`);
    await queryRunner.query(`ALTER TABLE task_attempts DROP COLUMN IF EXISTS last_heartbeat_at`);
    await queryRunner.query(`ALTER TABLE task_attempts DROP COLUMN IF EXISTS unit_name`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS rationale`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS display_title`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS workspace_path`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS depends_on`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS agent_version`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS agent_id`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS capability`);
    await queryRunner.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS current_plan_version`);
    await queryRunner.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS planner_summary`);
  }
}
