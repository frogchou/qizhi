CREATE TABLE IF NOT EXISTS ntfs_caller_policies (
    caller_sid TEXT PRIMARY KEY NOT NULL,
    allowed_roots_json TEXT NOT NULL,
    updated_at_utc_ms INTEGER NOT NULL
);
