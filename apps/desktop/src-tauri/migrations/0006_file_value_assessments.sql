CREATE TABLE IF NOT EXISTS file_value_assessments (
  canonical_path TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  modified_at_utc_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  confidence REAL,
  message TEXT,
  evaluated_at_utc_ms INTEGER NOT NULL,
  PRIMARY KEY(canonical_path, file_identity, modified_at_utc_ms)
);

CREATE INDEX IF NOT EXISTS idx_file_value_assessments_evaluated
  ON file_value_assessments(evaluated_at_utc_ms DESC);

-- Older service indexes were bootstrapped only from FSCTL_ENUM_USN_DATA.
-- Windows deliberately returns zero timestamps for those enumeration records,
-- so force one rebuild that also replays the retained journal history.
DELETE FROM ntfs_checkpoints;
