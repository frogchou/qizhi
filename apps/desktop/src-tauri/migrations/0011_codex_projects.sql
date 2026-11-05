CREATE TABLE IF NOT EXISTS codex_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT,
  root_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active','archived','deleted')),
  created_at_utc_ms INTEGER NOT NULL,
  updated_at_utc_ms INTEGER NOT NULL,
  last_opened_at_utc_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_projects_status_opened
  ON codex_projects(status, last_opened_at_utc_ms DESC, id);

CREATE TABLE IF NOT EXISTS codex_conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  codex_thread_id TEXT,
  codex_session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','ready','running','interrupted','unavailable','archived')),
  created_at_utc_ms INTEGER NOT NULL,
  updated_at_utc_ms INTEGER NOT NULL,
  archived_at_utc_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_codex_conversations_project_updated
  ON codex_conversations(project_id, updated_at_utc_ms DESC, id);

CREATE TABLE IF NOT EXISTS codex_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES codex_conversations(id) ON DELETE CASCADE,
  codex_turn_id TEXT,
  user_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','interrupted','failed')),
  started_at_utc_ms INTEGER NOT NULL,
  completed_at_utc_ms INTEGER,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_codex_turns_conversation_started
  ON codex_turns(conversation_id, started_at_utc_ms, id);

CREATE TABLE IF NOT EXISTS codex_messages (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  markdown TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('streaming','completed','interrupted','failed')),
  created_at_utc_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_messages_turn_created
  ON codex_messages(turn_id, created_at_utc_ms, id);

CREATE TABLE IF NOT EXISTS codex_process_items (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  codex_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  safe_summary TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(turn_id, codex_item_id)
);

CREATE TABLE IF NOT EXISTS codex_materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('local','ragflow_chunk','ragflow_document')),
  display_name TEXT NOT NULL,
  origin_reference TEXT,
  current_version_id TEXT,
  snapshot_state TEXT NOT NULL CHECK(snapshot_state IN ('ready','source_changed','unsupported','failed','removed')),
  imported_at_utc_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_materials_project_imported
  ON codex_materials(project_id, imported_at_utc_ms DESC, id);

CREATE TABLE IF NOT EXISTS codex_material_versions (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES codex_materials(id) ON DELETE CASCADE,
  original_snapshot_path TEXT NOT NULL,
  derived_snapshot_path TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  mime_type TEXT NOT NULL,
  extractor_version TEXT,
  created_at_utc_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_material_versions_material_created
  ON codex_material_versions(material_id, created_at_utc_ms DESC, id);

CREATE TABLE IF NOT EXISTS codex_turn_material_versions (
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  material_version_id TEXT NOT NULL REFERENCES codex_material_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY(turn_id, material_version_id)
);

CREATE TABLE IF NOT EXISTS codex_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  mime_type TEXT NOT NULL,
  created_by_conversation_id TEXT REFERENCES codex_conversations(id) ON DELETE SET NULL,
  created_by_turn_id TEXT REFERENCES codex_turns(id) ON DELETE SET NULL,
  detected_at_utc_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','missing')),
  UNIQUE(project_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_codex_artifacts_project_detected
  ON codex_artifacts(project_id, detected_at_utc_ms DESC, id);

CREATE TABLE IF NOT EXISTS codex_approval_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES codex_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES codex_conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_summary TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at_utc_ms INTEGER NOT NULL,
  UNIQUE(turn_id, item_id)
);

CREATE TABLE IF NOT EXISTS codex_preferences (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL
);

INSERT OR IGNORE INTO codex_preferences(id, model, reasoning_effort)
VALUES(1, '', 'medium');
