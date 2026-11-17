import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TaskRevisions1763395200000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query('ALTER TABLE tasks ADD COLUMN revision_number integer NOT NULL DEFAULT 0, ADD COLUMN effective_goal text');
    await db.query('ALTER TABLE task_acceptance_rounds ADD COLUMN revision_number integer NOT NULL DEFAULT 0');
    await db.query(`ALTER TABLE task_acceptance_rounds DROP CONSTRAINT task_acceptance_rounds_decision_check,
      ADD CONSTRAINT task_acceptance_rounds_decision_check CHECK(decision IN ('accept','supplement','revise','amend'))`);
    await db.query(`CREATE TABLE task_revisions (
      id uuid PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      revision_number integer NOT NULL CHECK (revision_number>0), review_id uuid REFERENCES task_acceptance_rounds(id),
      decision text NOT NULL CHECK(decision IN ('revise','amend')), message text NOT NULL,
      upload_ids text[] NOT NULL, input_ids text[] NOT NULL, idempotency_key text NOT NULL,
      effective_goal text NOT NULL, previous_delivery jsonb NOT NULL, plan_version integer,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,revision_number), UNIQUE(task_id,idempotency_key)
    )`);
  }
  async down(db: QueryRunner) {
    await db.query('DROP TABLE task_revisions');
    await db.query("UPDATE task_acceptance_rounds SET decision=NULL,decided_at=NULL WHERE decision IN ('revise','amend')");
    await db.query(`ALTER TABLE task_acceptance_rounds DROP CONSTRAINT task_acceptance_rounds_decision_check,
      ADD CONSTRAINT task_acceptance_rounds_decision_check CHECK(decision IN ('accept','supplement')), DROP COLUMN revision_number`);
    await db.query('ALTER TABLE tasks DROP COLUMN revision_number,DROP COLUMN effective_goal');
  }
}
