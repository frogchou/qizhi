import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialControlPlaneMigration implements MigrationInterface {
  name = 'InitialControlPlaneMigration1762735200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE agents (
        id text PRIMARY KEY,
        display_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE TABLE agent_versions (
        id text PRIMARY KEY,
        agent_id text NOT NULL REFERENCES agents(id),
        version text NOT NULL,
        status text NOT NULL,
        manifest jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        approved_at timestamptz,
        UNIQUE (agent_id, version)
      );
    `);
    await queryRunner.query(`
      CREATE TABLE tasks (
        id text PRIMARY KEY,
        goal text NOT NULL,
        acceptance_mode text NOT NULL,
        state text NOT NULL,
        workspace_path text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE TABLE task_plans (
        id text PRIMARY KEY,
        task_id text NOT NULL REFERENCES tasks(id),
        version integer NOT NULL,
        plan jsonb NOT NULL,
        state text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (task_id, version)
      );
    `);
    await queryRunner.query(`
      CREATE TABLE task_nodes (
        id text PRIMARY KEY,
        plan_id text NOT NULL REFERENCES task_plans(id),
        node_key text NOT NULL,
        state text NOT NULL,
        input jsonb NOT NULL DEFAULT '{}'::jsonb,
        output jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (plan_id, node_key)
      );
    `);
    await queryRunner.query(`
      CREATE TABLE task_attempts (
        id text PRIMARY KEY,
        task_node_id text NOT NULL REFERENCES task_nodes(id),
        instance_id text NOT NULL UNIQUE,
        attempt_number integer NOT NULL,
        lease_token text NOT NULL,
        lease_expires_at timestamptz NOT NULL,
        state text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (task_node_id, attempt_number)
      );
    `);
    await queryRunner.query(`
      CREATE TABLE task_events (
        id bigserial PRIMARY KEY,
        instance_id text NOT NULL,
        sequence integer NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (instance_id, sequence)
      );
    `);
    await queryRunner.query(`
      CREATE TABLE task_checkpoints (
        id text PRIMARY KEY,
        task_attempt_id text NOT NULL REFERENCES task_attempts(id),
        checkpoint jsonb NOT NULL,
        confirmed_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE TABLE approval_requests (
        id text PRIMARY KEY,
        task_id text NOT NULL REFERENCES tasks(id),
        kind text NOT NULL,
        state text NOT NULL,
        decision jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
      );
    `);
    await queryRunner.query(`
      CREATE TABLE audit_events (
        id bigserial PRIMARY KEY,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        actor text NOT NULL,
        action text NOT NULL,
        payload jsonb NOT NULL
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS audit_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS approval_requests`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_checkpoints`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_attempts`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_nodes`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_plans`);
    await queryRunner.query(`DROP TABLE IF EXISTS tasks`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_versions`);
    await queryRunner.query(`DROP TABLE IF EXISTS agents`);
  }
}
