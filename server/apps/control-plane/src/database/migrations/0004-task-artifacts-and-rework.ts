import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Keeps every verified deliverable version available after a later rework. */
export class TaskArtifactsAndReworkMigration implements MigrationInterface {
  name = 'TaskArtifactsAndReworkMigration1762994400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE task_attempts ADD COLUMN result jsonb`);
    await queryRunner.query(`CREATE TABLE task_artifacts (
      id text PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id),
      task_node_id text NOT NULL REFERENCES task_nodes(id),
      task_attempt_id text NOT NULL REFERENCES task_attempts(id),
      revision integer NOT NULL CHECK (revision > 0),
      original_path text NOT NULL,
      storage_path text NOT NULL,
      file_name text NOT NULL,
      media_type text NOT NULL,
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (task_attempt_id, original_path),
      UNIQUE (task_node_id, revision, original_path)
    )`);
    await queryRunner.query(`CREATE INDEX task_artifacts_task_id_created_at_idx ON task_artifacts(task_id, created_at DESC)`);
    await queryRunner.query(`CREATE INDEX task_artifacts_task_node_id_revision_idx ON task_artifacts(task_node_id, revision DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS task_artifacts`);
    await queryRunner.query(`ALTER TABLE task_attempts DROP COLUMN IF EXISTS result`);
  }
}
