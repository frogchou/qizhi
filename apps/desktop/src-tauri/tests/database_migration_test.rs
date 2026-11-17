use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    contracts::{FileRecordInput, LocalDayRange},
    database::Database,
};

fn temporary_database_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after epoch")
        .as_nanos();

    std::env::temp_dir().join(format!("qizhi-{name}-{nonce}.sqlite"))
}

#[test]
fn migrates_a_fresh_database_and_upserts_one_file_identity() {
    let path = temporary_database_path("migration");
    let database = Database::open(&path).expect("database opens and migrates");
    let repository = database.files();
    let record = FileRecordInput {
        canonical_path: r"D:\\work\\weekly-report.docx".to_owned(),
        file_identity: "volume-a:file-42".to_owned(),
        modified_at_utc_ms: 1_793_189_400_000,
        size_bytes: 1024,
        source: "本机 NTFS 索引".to_owned(),
    };

    repository.upsert(&record).expect("first upsert succeeds");
    repository.upsert(&record).expect("second upsert succeeds");

    assert_eq!(database.schema_version().expect("schema version reads"), 14);
    assert_eq!(repository.count().expect("record count reads"), 1);

    let _ = std::fs::remove_file(path);
}

#[test]
fn lists_records_inclusive_of_day_start_and_exclusive_of_next_day_start() {
    let path = temporary_database_path("day-boundary");
    let database = Database::open(&path).expect("database opens and migrates");
    let repository = database.files();
    let day = LocalDayRange::new(1_793_145_600_000, 1_793_232_000_000);

    for (identity, timestamp) in [
        ("at-start", 1_793_145_600_000),
        ("before-end", 1_793_231_999_999),
        ("at-next-start", 1_793_232_000_000),
    ] {
        repository
            .upsert(&FileRecordInput {
                canonical_path: format!(r"D:\\work\\{identity}.txt"),
                file_identity: identity.to_owned(),
                modified_at_utc_ms: timestamp,
                size_bytes: 1,
                source: "本机 NTFS 索引".to_owned(),
            })
            .expect("upsert succeeds");
    }

    let results = repository
        .list_for_local_day(day)
        .expect("day query succeeds");

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].file_identity, "at-start");
    assert_eq!(results[1].file_identity, "before-end");

    let _ = std::fs::remove_file(path);
}

#[test]
fn migrates_existing_database_to_the_ntfs_index_schema() {
    let path = temporary_database_path("ntfs-index");
    let database = Database::open(&path).expect("database opens");

    assert_eq!(database.schema_version().expect("schema version"), 14);

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn basket_upgrade_preserves_existing_codex_handoffs_and_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let database = Database::open(&path).unwrap();
    let project = database
        .codex()
        .create_project("已有项目", None, "managed", 1)
        .unwrap();
    let chat = database
        .codex()
        .create_conversation(&project.id, "已有会话", 1)
        .unwrap();
    let original = database
        .codex()
        .create_handoff("legacy-linked", "today", &project.id, &chat.id, 1)
        .unwrap();
    let material =
        qizhi_desktop_lib::database::repositories::codex_repository::CommitHandoffMaterialInput {
            kind: "local".into(),
            origin_reference: "fixture:doc".into(),
            display_name: "报告.md".into(),
            source_metadata_json: "{}".into(),
            original_snapshot_path: "materials/local/report.md".into(),
            derived_snapshot_path: None,
            content_hash: "test".into(),
            size_bytes: 4,
            mime_type: "text/markdown".into(),
            extractor_version: "qizhi-1".into(),
            created_at_utc_ms: 1,
            display_order: 0,
        };
    database
        .codex()
        .commit_handoff_materials(&original.id, &project.id, &[material])
        .unwrap();
    drop(database);
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='codex_handoffs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // Recreate the pre-basket CHECK constraint while preserving the existing turn/material links.
        let previous = sql.replace(",'basket'", "");
        conn.execute_batch(&format!("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN; ALTER TABLE codex_handoffs RENAME TO old_handoffs; {previous}; INSERT INTO codex_handoffs SELECT * FROM old_handoffs; DROP TABLE old_handoffs; CREATE INDEX idx_codex_handoffs_conversation_status ON codex_handoffs(conversation_id,status,created_at_utc_ms,id); DROP TABLE material_basket; DELETE FROM schema_migrations WHERE version=14; COMMIT;")).unwrap();
    }
    let reopened = Database::open(&path).unwrap();
    let queue = reopened.codex().list_pending_handoffs(&chat.id).unwrap();
    assert_eq!(queue[0].handoff.id, original.id);
    assert_eq!(queue[0].items[0].display_name, "报告.md");
    let references = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(references, 0);
    drop(reopened);
    assert_eq!(Database::open(&path).unwrap().schema_version().unwrap(), 14);
}
