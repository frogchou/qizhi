import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stable identity and immutable version history survive removal from the live catalog. */
export class AgentRetirement1763308800000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE agents ADD COLUMN lifecycle text NOT NULL DEFAULT 'active'
      CHECK (lifecycle IN ('active','deleting','deleted')), ADD COLUMN deleted_at timestamptz,
      ADD COLUMN deleted_version_count integer NOT NULL DEFAULT 0`);
    await db.query("CREATE INDEX idx_agents_pending_delete ON agents(id) WHERE lifecycle='deleting'");
  }
  async down(db: QueryRunner) {
    await db.query('DROP INDEX idx_agents_pending_delete');
    await db.query(
      'ALTER TABLE agents DROP COLUMN deleted_version_count, DROP COLUMN deleted_at, DROP COLUMN lifecycle',
    );
  }
}
