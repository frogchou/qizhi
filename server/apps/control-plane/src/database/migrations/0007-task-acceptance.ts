import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TaskAcceptance1763136000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE task_acceptance_rounds (
      id uuid PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      round integer NOT NULL CHECK (round > 0), criteria jsonb NOT NULL, assessment jsonb NOT NULL,
      decision text CHECK (decision IN ('accept','supplement')), decided_at timestamptz,
      supplement_node jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,round)
    )`);
  }
  async down(q: QueryRunner) { await q.query('DROP TABLE task_acceptance_rounds'); }
}
