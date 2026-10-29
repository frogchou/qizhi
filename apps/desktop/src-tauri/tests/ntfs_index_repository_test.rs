use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    database::Database,
    ntfs::{
        CallerIndexPolicy, DiscoveredEvent, IndexEntry, IndexPage, UsnCheckpoint, VolumeDescriptor,
        VolumeState,
    },
};

fn temporary_database_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("qizhi-{name}-{nonce}.sqlite"))
}

fn work_volume() -> VolumeDescriptor {
    VolumeDescriptor {
        volume_guid: r"\\?\Volume{work}".to_owned(),
        current_mount_path: r"D:\".to_owned(),
        serial_number: Some("A1B2-C3D4".to_owned()),
        file_system: "NTFS".to_owned(),
        state: VolumeState::Ready,
        state_message: None,
    }
}

#[test]
fn persists_an_index_page_and_returns_today_events() {
    let path = temporary_database_path("ntfs-index-page");
    let database = Database::open(&path).expect("database opens");
    let repository = database.ntfs_index();
    let volume = repository
        .upsert_volume(&work_volume())
        .expect("volume persists");

    repository
        .apply_page(&IndexPage {
            volume_id: volume.id,
            entries: vec![IndexEntry {
                file_reference_number: "42".to_owned(),
                parent_file_reference_number: Some("5".to_owned()),
                name: "weekly-report.docx".to_owned(),
                is_directory: false,
                file_attributes: 0,
                size_bytes: Some(1024),
                modified_at_utc_ms: Some(1_793_189_400_000),
                last_usn: "9001".to_owned(),
                deleted_at_utc_ms: None,
            }],
            events: vec![DiscoveredEvent {
                file_reference_number: "42".to_owned(),
                canonical_path: r"D:\work\weekly-report.docx".to_owned(),
                event_kind: "modified".to_owned(),
                modified_at_utc_ms: 1_793_189_400_000,
                size_bytes: Some(1024),
                source: "本机 NTFS 索引".to_owned(),
            }],
            checkpoint: UsnCheckpoint {
                usn_journal_id: "journal-1".to_owned(),
                next_usn: "9002".to_owned(),
                first_usn_seen: "8000".to_owned(),
                record_major_version: 2,
                last_successful_sync_at_utc_ms: 1_793_189_401_000,
            },
        })
        .expect("index page applies atomically");

    let events = repository
        .list_events_between(1_793_145_600_000, 1_793_232_000_000)
        .expect("today events read");
    let checkpoint = repository
        .checkpoint_for(volume.id)
        .expect("checkpoint reads")
        .expect("checkpoint exists");

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].canonical_path, r"D:\work\weekly-report.docx");
    assert_eq!(checkpoint.next_usn, "9002");

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn rejects_a_page_for_an_unknown_volume_without_advancing_a_checkpoint() {
    let path = temporary_database_path("ntfs-index-atomic");
    let database = Database::open(&path).expect("database opens");
    let repository = database.ntfs_index();

    let result = repository.apply_page(&IndexPage {
        volume_id: 999,
        entries: vec![],
        events: vec![],
        checkpoint: UsnCheckpoint {
            usn_journal_id: "journal-1".to_owned(),
            next_usn: "9002".to_owned(),
            first_usn_seen: "8000".to_owned(),
            record_major_version: 2,
            last_successful_sync_at_utc_ms: 1_793_189_401_000,
        },
    });

    assert!(result.is_err());
    assert!(
        repository
            .checkpoint_for(999)
            .expect("checkpoint query succeeds")
            .is_none()
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn stores_scan_authorization_by_authenticated_windows_sid() {
    let path = temporary_database_path("ntfs-caller-policy");
    let database = Database::open(&path).expect("database opens");
    let repository = database.ntfs_index();
    let policy = CallerIndexPolicy {
        caller_sid: "S-1-5-21-100".to_owned(),
        allowed_roots: vec![
            r"D:\\work".to_owned(),
            r"C:\\Users\\fcc\\Documents".to_owned(),
        ],
        updated_at_utc_ms: 1_793_189_401_000,
    };

    repository
        .replace_caller_policy(&policy)
        .expect("caller policy persists");
    let stored = repository
        .caller_policy(&policy.caller_sid)
        .expect("policy reads")
        .expect("policy exists");

    assert_eq!(stored, policy);

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn keeps_the_last_ready_index_visible_until_a_rebuild_is_published() {
    let path = temporary_database_path("ntfs-staged-build");
    let database = Database::open(&path).expect("database opens");
    let repository = database.ntfs_index();
    let volume = repository
        .upsert_volume(&work_volume())
        .expect("volume persists");

    repository
        .apply_page(&IndexPage {
            volume_id: volume.id,
            entries: vec![],
            events: vec![DiscoveredEvent {
                file_reference_number: "old".to_owned(),
                canonical_path: r"D:\\work\\old.docx".to_owned(),
                event_kind: "modified".to_owned(),
                modified_at_utc_ms: 1_793_189_400_000,
                size_bytes: Some(1),
                source: "本机 NTFS 索引".to_owned(),
            }],
            checkpoint: UsnCheckpoint {
                usn_journal_id: "journal-1".to_owned(),
                next_usn: "10".to_owned(),
                first_usn_seen: "1".to_owned(),
                record_major_version: 2,
                last_successful_sync_at_utc_ms: 1_793_189_401_000,
            },
        })
        .expect("old index persists");

    repository
        .begin_rebuild(volume.id, "build-1", 1_793_189_402_000)
        .expect("build begins");
    repository
        .stage_rebuild_page(
            volume.id,
            "build-1",
            &IndexPage {
                volume_id: volume.id,
                entries: vec![],
                events: vec![DiscoveredEvent {
                    file_reference_number: "new".to_owned(),
                    canonical_path: r"D:\\work\\new.docx".to_owned(),
                    event_kind: "modified".to_owned(),
                    modified_at_utc_ms: 1_793_189_402_000,
                    size_bytes: Some(2),
                    source: "本机 NTFS 索引".to_owned(),
                }],
                checkpoint: UsnCheckpoint {
                    usn_journal_id: "journal-2".to_owned(),
                    next_usn: "20".to_owned(),
                    first_usn_seen: "11".to_owned(),
                    record_major_version: 2,
                    last_successful_sync_at_utc_ms: 1_793_189_403_000,
                },
            },
        )
        .expect("new data stages");

    assert_eq!(
        repository
            .checkpoint_for(volume.id)
            .expect("checkpoint reads")
            .expect("old checkpoint remains")
            .next_usn,
        "10"
    );
    assert_eq!(
        repository
            .list_events_between(1_793_145_600_000, 1_793_232_000_000)
            .expect("events read")[0]
            .file_reference_number,
        "old"
    );

    repository
        .publish_rebuild(volume.id, "build-1", 1_793_189_404_000)
        .expect("build publishes atomically");

    assert_eq!(
        repository
            .checkpoint_for(volume.id)
            .expect("checkpoint reads")
            .expect("new checkpoint persists")
            .next_usn,
        "20"
    );
    assert_eq!(
        repository
            .list_events_between(1_793_145_600_000, 1_793_232_000_000)
            .expect("events read")[0]
            .file_reference_number,
        "new"
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}
