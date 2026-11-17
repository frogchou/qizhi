import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores durable human questions and answers without holding an agent lease. */
export class TaskInteractionsMigration implements MigrationInterface {
  name = 'TaskInteractionsMigration1763049600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // task_nodes predates human-interaction nodes.  Keep its existing rows
    // readable while recording the immutable compiled definition for every
    // newly materialised runtime node.
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN node_type text NOT NULL DEFAULT 'agent_call'`);
    await queryRunner.query(`ALTER TABLE task_nodes ADD COLUMN definition jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`CREATE TABLE task_interactions (
      id text PRIMARY KEY,
      task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_plan_id text REFERENCES task_plans(id) ON DELETE SET NULL,
      task_node_id text REFERENCES task_nodes(id) ON DELETE SET NULL,
      plan_node_key text NOT NULL,
      source text NOT NULL CHECK (source IN ('control_plane','agent')),
      kind text NOT NULL CHECK (kind IN ('confirmation','clarification','form')),
      title text NOT NULL,
      prompt text NOT NULL,
      response_schema jsonb NOT NULL,
      response_target text NOT NULL,
      state text NOT NULL CHECK (state IN ('pending','answered','resumed','cancelled','expired')),
      checkpoint jsonb,
      requested_by_attempt_id text REFERENCES task_attempts(id) ON DELETE SET NULL,
      answer jsonb,
      answer_message text,
      answered_by_subject text,
      idempotency_key text,
      resume_round integer NOT NULL DEFAULT 0 CHECK (resume_round >= 0),
      requested_at timestamptz NOT NULL DEFAULT now(),
      answered_at timestamptz,
      resumed_at timestamptz,
      expires_at timestamptz,
      UNIQUE (task_id, idempotency_key)
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX task_interactions_pending_plan_node_idx ON task_interactions(task_id, plan_node_key, resume_round) WHERE state='pending'`);
    await queryRunner.query(`CREATE INDEX task_interactions_task_requested_idx ON task_interactions(task_id, requested_at)`);
    await queryRunner.query(`CREATE TABLE task_interaction_messages (
      id bigserial PRIMARY KEY,
      interaction_id text NOT NULL REFERENCES task_interactions(id) ON DELETE CASCADE,
      sequence integer NOT NULL CHECK (sequence > 0),
      role text NOT NULL CHECK (role IN ('control_plane','agent','user','system')),
      content text,
      structured_content jsonb NOT NULL DEFAULT '{}'::jsonb,
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (interaction_id, sequence)
    )`);
    await queryRunner.query(`CREATE INDEX task_interaction_messages_interaction_sequence_idx ON task_interaction_messages(interaction_id, sequence)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS task_interaction_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_interactions`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS definition`);
    await queryRunner.query(`ALTER TABLE task_nodes DROP COLUMN IF EXISTS node_type`);
  }
}
