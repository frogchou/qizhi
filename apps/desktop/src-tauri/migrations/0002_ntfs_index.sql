CREATE TABLE IF NOT EXISTS ntfs_volumes (
  id INTEGER PRIMARY KEY,
  volume_guid TEXT NOT NULL UNIQUE,
  current_mount_path TEXT NOT NULL,
  serial_number TEXT,
  file_system TEXT NOT NULL,
  state TEXT NOT NULL,
  state_message TEXT,
  last_indexed_at_utc_ms INTEGER,
  last_error_at_utc_ms INTEGER
);

CREATE TABLE IF NOT EXISTS ntfs_entries (
  volume_id INTEGER NOT NULL,
  file_reference_number TEXT NOT NULL,
  parent_file_reference_number TEXT,
  name TEXT NOT NULL,
  is_directory INTEGER NOT NULL,
  file_attributes INTEGER NOT NULL,
  size_bytes INTEGER,
  modified_at_utc_ms INTEGER,
  last_usn TEXT NOT NULL,
  deleted_at_utc_ms INTEGER,
  PRIMARY KEY(volume_id, file_reference_number),
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ntfs_entries_parent
  ON ntfs_entries(volume_id, parent_file_reference_number);

CREATE TABLE IF NOT EXISTS ntfs_checkpoints (
  volume_id INTEGER PRIMARY KEY,
  usn_journal_id TEXT NOT NULL,
  next_usn TEXT NOT NULL,
  first_usn_seen TEXT NOT NULL,
  record_major_version INTEGER NOT NULL,
  last_successful_sync_at_utc_ms INTEGER NOT NULL,
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discovered_file_events (
  id INTEGER PRIMARY KEY,
  volume_id INTEGER NOT NULL,
  file_reference_number TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  modified_at_utc_ms INTEGER NOT NULL,
  size_bytes INTEGER,
  source TEXT NOT NULL,
  UNIQUE(volume_id, file_reference_number),
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discovered_file_events_today
  ON discovered_file_events(modified_at_utc_ms DESC);
