PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS material_basket (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('local','today','recent','ragflowChunk','ragflowDocument')),
    display_name TEXT NOT NULL,
    source_label TEXT NOT NULL,
    source_key TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    added_at_utc_ms INTEGER NOT NULL,
    UNIQUE(source_key, sha256)
);

ALTER TABLE codex_handoffs RENAME TO codex_handoffs_0014;
CREATE TABLE codex_handoffs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('today','recent','ragflow_chunks','ragflow_document','ragflow_answer','basket')),
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES codex_conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('preparing','ready','consumed','failed','cancelled')),
  created_at_utc_ms INTEGER NOT NULL,
  consumed_at_utc_ms INTEGER,
  error_summary TEXT
);
INSERT INTO codex_handoffs SELECT * FROM codex_handoffs_0014;
DROP TABLE codex_handoffs_0014;
CREATE INDEX idx_codex_handoffs_conversation_status ON codex_handoffs(conversation_id,status,created_at_utc_ms,id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (14);
COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
