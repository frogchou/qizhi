BEGIN;

CREATE TABLE index_configuration (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL,
    rules TEXT NOT NULL
) STRICT;

CREATE TABLE scan_roots (
    path TEXT PRIMARY KEY,
    volume TEXT,
    device TEXT,
    identity TEXT,
    state INTEGER NOT NULL CHECK (state BETWEEN 0 AND 3)
) STRICT;

CREATE TABLE indexed_files (
    path TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    modified_ms INTEGER NOT NULL,
    observed_ms INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    change_ms INTEGER GENERATED ALWAYS AS (max(created_ms, modified_ms, observed_ms)) STORED
) STRICT;

CREATE INDEX indexed_files_by_change ON indexed_files (change_ms, path);

CREATE TABLE root_files (
    root TEXT NOT NULL REFERENCES scan_roots (path) ON DELETE CASCADE,
    path TEXT NOT NULL REFERENCES indexed_files (path) ON DELETE CASCADE,
    PRIMARY KEY (root, path)
) STRICT;

CREATE INDEX root_files_by_path ON root_files (path);

CREATE TABLE blocked_directories (
    root TEXT NOT NULL REFERENCES scan_roots (path) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (root, path)
) STRICT;

CREATE TABLE volume_positions (
    volume TEXT PRIMARY KEY,
    event_store TEXT NOT NULL,
    event_id TEXT NOT NULL
) STRICT;

PRAGMA user_version = 1;
COMMIT;
