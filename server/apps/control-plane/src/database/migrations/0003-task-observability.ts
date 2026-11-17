import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores the user-visible, reconnectable lifecycle for every task. */
export class TaskObservabilityMigration implements MigrationInterface {
  name = 'TaskObservabilityMigration1762908000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE task_activity_events (
      id bigserial PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id),
      kind text NOT NULL,
      state text,
      message text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      source text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX task_activity_events_task_id_id_idx ON task_activity_events(task_id, id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS task_activity_events`);
  }
}
