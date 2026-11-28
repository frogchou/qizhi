BEGIN;

ALTER TABLE indexed_files ADD COLUMN search_path TEXT NOT NULL DEFAULT '';
ALTER TABLE indexed_files ADD COLUMN search_name TEXT NOT NULL DEFAULT '';
ALTER TABLE indexed_files ADD COLUMN search_prefix TEXT NOT NULL DEFAULT '';

CREATE VIRTUAL TABLE indexed_file_trigrams USING fts5(
    search_name, search_path, content='indexed_files', content_rowid='rowid', tokenize='trigram case_sensitive 1'
);

CREATE INDEX indexed_files_search_by_name ON indexed_files (search_name, modified_ms DESC);
CREATE INDEX indexed_files_search_by_modified ON indexed_files (modified_ms DESC);

CREATE TABLE indexed_file_short_terms (
    term TEXT NOT NULL,
    rank INTEGER NOT NULL,
    modified_order INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    PRIMARY KEY (term, rank, modified_order, file_id)
) WITHOUT ROWID;

CREATE INDEX indexed_file_short_terms_by_file ON indexed_file_short_terms (file_id);

CREATE INDEX indexed_files_by_identity ON indexed_files (identity);

CREATE VIEW covered_root_files AS
SELECT member.root, member.path FROM root_files member JOIN scan_roots root ON root.path = member.root
WHERE root.state IN (1, 2) AND NOT EXISTS (
    SELECT 1 FROM blocked_directories blocked WHERE blocked.root = member.root
    AND (blocked.path = member.path OR substr(member.path, 1, length(blocked.path) + 1) = blocked.path || '/')
);

CREATE TRIGGER indexed_file_search_insert AFTER INSERT ON indexed_files
WHEN new.search_path <> '' BEGIN
    INSERT INTO indexed_file_trigrams (rowid, search_name, search_path) VALUES (new.rowid, new.search_name, new.search_path);
END;

CREATE TRIGGER indexed_file_search_update AFTER UPDATE OF search_path ON indexed_files
WHEN old.search_path <> new.search_path BEGIN
    INSERT INTO indexed_file_trigrams (indexed_file_trigrams, rowid, search_name, search_path)
        SELECT 'delete', old.rowid, old.search_name, old.search_path WHERE old.search_path <> '';
    INSERT INTO indexed_file_trigrams (rowid, search_name, search_path) VALUES (new.rowid, new.search_name, new.search_path);
END;

CREATE TRIGGER indexed_file_search_delete BEFORE DELETE ON indexed_files BEGIN
    INSERT INTO indexed_file_trigrams (indexed_file_trigrams, rowid, search_name, search_path)
        SELECT 'delete', old.rowid, old.search_name, old.search_path WHERE old.search_path <> '';
    DELETE FROM indexed_file_short_terms WHERE file_id = old.rowid;
END;

-- The background scanner rebuilds the derived index for records from version 1.
UPDATE scan_roots SET state = 0;
PRAGMA user_version = 2;
COMMIT;
