import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InputOrigin1763481600000 implements MigrationInterface {
  async up(db: QueryRunner) {
    await db.query(`ALTER TABLE task_input_uploads
      ADD COLUMN source_type text NOT NULL DEFAULT 'uploaded_file',
      ADD COLUMN basket_item_id uuid,
      ADD CONSTRAINT task_input_uploads_origin CHECK (
        (source_type='uploaded_file' AND basket_item_id IS NULL) OR
        (source_type IN ('qizhi_local_file','ragflow_chunk','ragflow_document') AND basket_item_id IS NOT NULL)
      )`);
  }
  async down(db: QueryRunner) {
    await db.query('ALTER TABLE task_input_uploads DROP CONSTRAINT task_input_uploads_origin, DROP COLUMN basket_item_id, DROP COLUMN source_type');
  }
}
