CREATE TABLE IF NOT EXISTS ntfs_rebuilds (
  build_id TEXT PRIMARY KEY,
  volume_id INTEGER NOT NULL,
  started_at_utc_ms INTEGER NOT NULL,
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ntfs_rebuild_entries (
  build_id TEXT NOT NULL,
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
  PRIMARY KEY(build_id, file_reference_number),
  FOREIGN KEY(build_id) REFERENCES ntfs_rebuilds(build_id) ON DELETE CASCADE,
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ntfs_rebuild_events (
  build_id TEXT NOT NULL,
  volume_id INTEGER NOT NULL,
  file_reference_number TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  modified_at_utc_ms INTEGER NOT NULL,
  size_bytes INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY(build_id, file_reference_number),
  FOREIGN KEY(build_id) REFERENCES ntfs_rebuilds(build_id) ON DELETE CASCADE,
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ntfs_rebuild_checkpoints (
  build_id TEXT PRIMARY KEY,
  volume_id INTEGER NOT NULL,
  usn_journal_id TEXT NOT NULL,
  next_usn TEXT NOT NULL,
  first_usn_seen TEXT NOT NULL,
  record_major_version INTEGER NOT NULL,
  last_successful_sync_at_utc_ms INTEGER NOT NULL,
  FOREIGN KEY(build_id) REFERENCES ntfs_rebuilds(build_id) ON DELETE CASCADE,
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);
