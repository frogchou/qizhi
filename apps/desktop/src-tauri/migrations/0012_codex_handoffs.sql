PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

BEGIN IMMEDIATE;

ALTER TABLE codex_materials RENAME TO codex_materials_0011;

CREATE TABLE codex_materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('local','ragflow_chunk','ragflow_document','ragflow_answer')),
  display_name TEXT NOT NULL,
  origin_reference TEXT,
  source_metadata_json TEXT,
  current_version_id TEXT,
  snapshot_state TEXT NOT NULL CHECK(snapshot_state IN ('ready','source_changed','unsupported','failed','removed')),
  imported_at_utc_ms INTEGER NOT NULL
);

INSERT INTO codex_materials(
  id,project_id,kind,display_name,origin_reference,source_metadata_json,
  current_version_id,snapshot_state,imported_at_utc_ms
)
SELECT
  id,project_id,kind,display_name,origin_reference,NULL,
  current_version_id,snapshot_state,imported_at_utc_ms
FROM codex_materials_0011;

DROP TABLE codex_materials_0011;

CREATE INDEX idx_codex_materials_project_imported
  ON codex_materials(project_id, imported_at_utc_ms DESC, id);

CREATE TABLE codex_handoffs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('today','recent','ragflow_chunks','ragflow_document','ragflow_answer')),
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES codex_conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('preparing','ready','consumed','failed','cancelled')),
  created_at_utc_ms INTEGER NOT NULL,
  consumed_at_utc_ms INTEGER,
  error_summary TEXT
);

CREATE INDEX idx_codex_handoffs_conversation_status
  ON codex_handoffs(conversation_id, status, created_at_utc_ms, id);

CREATE TABLE codex_handoff_items (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES codex_handoffs(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES codex_materials(id) ON DELETE CASCADE,
  material_version_id TEXT NOT NULL REFERENCES codex_material_versions(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  source_metadata_json TEXT NOT NULL,
  display_order INTEGER NOT NULL CHECK(display_order >= 0),
  state TEXT NOT NULL CHECK(state IN ('ready','dismissed','consumed')),
  UNIQUE(handoff_id, material_id)
);

CREATE INDEX idx_codex_handoff_items_handoff_order
  ON codex_handoff_items(handoff_id, display_order, id);

CREATE TABLE codex_turn_handoffs (
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  handoff_id TEXT NOT NULL REFERENCES codex_handoffs(id) ON DELETE RESTRICT,
  PRIMARY KEY(turn_id, handoff_id)
);

CREATE TABLE codex_artifact_uploads (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES codex_artifacts(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL,
  parent_path TEXT,
  content_hash TEXT NOT NULL,
  document_ids_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('uploading','uploaded','uploaded_parse_failed','uncertain','failed')),
  start_parsing INTEGER NOT NULL CHECK(start_parsing IN (0,1)),
  created_at_utc_ms INTEGER NOT NULL,
  completed_at_utc_ms INTEGER,
  error_summary TEXT
);

CREATE INDEX idx_codex_artifact_uploads_artifact_created
  ON codex_artifact_uploads(artifact_id, created_at_utc_ms DESC, id);

COMMIT;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
