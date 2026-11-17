import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable provenance and immutable snapshots for materials attached to a task. */
export class TaskInputsMigration implements MigrationInterface {
  name = 'TaskInputsMigration1762998000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE task_input_uploads (
      id text PRIMARY KEY,
      owner_subject text NOT NULL,
      original_filename text NOT NULL,
      media_type text NOT NULL,
      size_bytes bigint NOT NULL CHECK (size_bytes > 0),
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      storage_key text NOT NULL,
      state text NOT NULL CHECK (state IN ('ready', 'consumed', 'discarded')),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )`);
    await queryRunner.query(`CREATE INDEX task_input_uploads_owner_state_expiry_idx ON task_input_uploads(owner_subject, state, expires_at)`);
    await queryRunner.query(`CREATE TABLE task_inputs (
      id text PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      source_type text NOT NULL CHECK (source_type IN ('uploaded_file', 'ragflow_document', 'ragflow_chunk', 'agent_artifact', 'qizhi_local_file')),
      display_name text NOT NULL,
      original_filename text NOT NULL,
      media_type text NOT NULL,
      size_bytes bigint NOT NULL CHECK (size_bytes > 0),
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      workspace_relative_path text NOT NULL,
      source_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
      provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (task_id, workspace_relative_path)
    )`);
    await queryRunner.query(`CREATE INDEX task_inputs_task_created_idx ON task_inputs(task_id, created_at)`);
    await queryRunner.query(`CREATE TABLE task_input_audits (
      id bigserial PRIMARY KEY,
      task_id text REFERENCES tasks(id) ON DELETE CASCADE,
      task_input_id text REFERENCES task_inputs(id) ON DELETE CASCADE,
      upload_id text REFERENCES task_input_uploads(id) ON DELETE SET NULL,
      action text NOT NULL,
      actor_subject text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX task_input_audits_task_created_idx ON task_input_audits(task_id, created_at)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS task_input_audits`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_inputs`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_input_uploads`);
  }
}
