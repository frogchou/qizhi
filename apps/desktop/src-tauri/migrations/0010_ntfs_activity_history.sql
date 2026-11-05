-- Keep a compact, per-file activity record for each local calendar day.
-- The NTFS entry row represents the file's latest known state; that alone
-- cannot answer whether the same file also changed earlier today or on a
-- previous day in the recent-work view.
CREATE TABLE IF NOT EXISTS ntfs_activity_events (
  volume_id INTEGER NOT NULL,
  file_reference_number TEXT NOT NULL,
  day_start_utc_ms INTEGER NOT NULL,
  occurred_at_utc_ms INTEGER NOT NULL,
  PRIMARY KEY(volume_id, file_reference_number, day_start_utc_ms),
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ntfs_activity_events_occurred
  ON ntfs_activity_events(occurred_at_utc_ms DESC);

CREATE TABLE IF NOT EXISTS ntfs_rebuild_activity_events (
  build_id TEXT NOT NULL,
  volume_id INTEGER NOT NULL,
  file_reference_number TEXT NOT NULL,
  day_start_utc_ms INTEGER NOT NULL,
  occurred_at_utc_ms INTEGER NOT NULL,
  PRIMARY KEY(build_id, file_reference_number, day_start_utc_ms),
  FOREIGN KEY(build_id) REFERENCES ntfs_rebuilds(build_id) ON DELETE CASCADE,
  FOREIGN KEY(volume_id) REFERENCES ntfs_volumes(id) ON DELETE CASCADE
);
