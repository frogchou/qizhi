CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS file_records (
  id INTEGER PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  modified_at_utc_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(canonical_path, file_identity)
);

CREATE TABLE IF NOT EXISTS app_config (
  service TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  credential_reference TEXT NOT NULL,
  api_key_mask TEXT NOT NULL
);
