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

    assert_eq!(database.schema_version().expect("schema version reads"), 12);
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

    assert_eq!(database.schema_version().expect("schema version"), 12);

    drop(database);
    let _ = std::fs::remove_file(path);
}
