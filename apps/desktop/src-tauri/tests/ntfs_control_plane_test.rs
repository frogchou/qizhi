use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    database::Database,
    ntfs::{
        CallerIndexPolicy, IndexEntry, IndexExecutor, IndexPage, IndexerControlPlane,
        UsnCheckpoint, VolumeDescriptor, VolumeState,
        ipc::{INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind},
    },
    scan::{file_filter::FileCategory, policy::display_path},
};

fn request(kind: IndexerRequestKind) -> IndexerRequest {
    IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: "request-1".to_owned(),
        kind,
    }
}

#[derive(Default)]
struct RecordingExecutor {
    operations: Mutex<Vec<(String, Vec<String>)>>,
}

impl IndexExecutor for RecordingExecutor {
    fn build(&self, policy: &CallerIndexPolicy) -> Result<(), String> {
        self.operations
            .lock()
            .expect("lock")
            .push(("build".to_owned(), policy.allowed_roots.clone()));
        Ok(())
    }

    fn sync(&self, policy: &CallerIndexPolicy) -> Result<(), String> {
        self.operations
            .lock()
            .expect("lock")
            .push(("sync".to_owned(), policy.allowed_roots.clone()));
        Ok(())
    }
}

struct FailingExecutor;

impl IndexExecutor for FailingExecutor {
    fn build(&self, _: &CallerIndexPolicy) -> Result<(), String> {
        Err("测试构建失败".to_owned())
    }

    fn sync(&self, _: &CallerIndexPolicy) -> Result<(), String> {
        Err("无法读取 NTFS 变更日志: Windows 错误 87".to_owned())
    }
}

#[test]
fn binds_saved_scan_roots_to_the_authenticated_pipe_sid() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("qizhi-ntfs-control-{nonce}.sqlite"));
    let database = Database::open(&path).expect("database opens");
    let control = IndexerControlPlane::new(database.ntfs_index());

    let configured = control.handle(
        "S-1-5-21-100",
        &request(IndexerRequestKind::Configure {
            allowed_roots: vec![r"D:\\work".to_owned()],
            excluded_roots: vec![],
            file_categories: vec![],
        }),
    );
    assert_eq!(configured.status, "ready");

    let owner = control.handle("S-1-5-21-100", &request(IndexerRequestKind::Build));
    assert_eq!(owner.status, "rejected");
    assert_eq!(
        owner.message.as_deref(),
        Some("本地索引服务尚未完成索引执行器配置")
    );

    let other_user = control.handle("S-1-5-21-999", &request(IndexerRequestKind::Build));
    assert_eq!(other_user.status, "rejected");
    assert_eq!(
        other_user.message.as_deref(),
        Some("扫描范围未获本地索引服务授权")
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn schedules_authorized_builds_without_blocking_the_pipe_request() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("qizhi-ntfs-control-build-{nonce}.sqlite"));
    let database = Database::open(&path).expect("database opens");
    let executor = Arc::new(RecordingExecutor::default());
    let control = IndexerControlPlane::with_executor(database.ntfs_index(), executor.clone());
    let sid = "S-1-5-21-100";

    control.handle(
        sid,
        &request(IndexerRequestKind::Configure {
            allowed_roots: vec![r"D:\\work".to_owned()],
            excluded_roots: vec![],
            file_categories: vec![],
        }),
    );
    let response = control.handle(sid, &request(IndexerRequestKind::Build));
    assert_eq!(response.status, "accepted");

    for _ in 0..20 {
        if !executor.operations.lock().expect("lock").is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        executor.operations.lock().expect("lock").as_slice(),
        [("build".to_owned(), vec![r"D:\\work".to_owned()])]
    );

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn returns_the_sanitized_sync_failure_to_the_local_client() {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let control =
        IndexerControlPlane::with_executor(database.ntfs_index(), Arc::new(FailingExecutor));
    let sid = "S-1-5-21-100";
    let configured = control.handle(
        sid,
        &request(IndexerRequestKind::Configure {
            allowed_roots: vec![r"D:\\work".to_owned()],
            excluded_roots: vec![],
            file_categories: vec![],
        }),
    );
    assert_eq!(configured.status, "ready");

    let response = control.handle(sid, &request(IndexerRequestKind::Sync));

    assert_eq!(response.status, "rejected");
    assert_eq!(
        response.message.as_deref(),
        Some("本地 NTFS 索引同步失败：无法读取 NTFS 变更日志: Windows 错误 87")
    );
}

#[test]
fn returns_only_candidates_allowed_by_the_saved_service_policy() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    // The platform temp directory is below AppData on Windows, which is
    // intentionally a denied privacy area. Use the project workspace so this
    // test exercises a normal, eligible work root instead.
    let root = std::env::current_dir()
        .expect("current directory")
        .join("target")
        .join(format!("qizhi-ntfs-visible-{nonce}"));
    let private = root.join("private");
    std::fs::create_dir_all(&private).expect("create test folders");
    let root = root.canonicalize().expect("canonical root");
    let private = private.canonicalize().expect("canonical private folder");
    let mount_path = format!("{}\\", display_path(&root));
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let volume = database
        .ntfs_index()
        .upsert_volume(&VolumeDescriptor {
            volume_guid: format!("visible-{nonce}"),
            current_mount_path: mount_path,
            serial_number: None,
            file_system: "NTFS".to_owned(),
            state: VolumeState::Ready,
            state_message: None,
        })
        .expect("persist volume");
    let now = 1_700_000_000_000_i64;
    database
        .ntfs_index()
        .apply_page(&IndexPage {
            volume_id: volume.id,
            entries: vec![
                IndexEntry {
                    file_reference_number: "root".to_owned(),
                    parent_file_reference_number: None,
                    name: String::new(),
                    is_directory: true,
                    file_attributes: 0,
                    size_bytes: None,
                    modified_at_utc_ms: None,
                    last_usn: "1".to_owned(),
                    deleted_at_utc_ms: None,
                },
                IndexEntry {
                    file_reference_number: "private".to_owned(),
                    parent_file_reference_number: Some("root".to_owned()),
                    name: "private".to_owned(),
                    is_directory: true,
                    file_attributes: 0,
                    size_bytes: None,
                    modified_at_utc_ms: None,
                    last_usn: "2".to_owned(),
                    deleted_at_utc_ms: None,
                },
                IndexEntry {
                    file_reference_number: "document".to_owned(),
                    parent_file_reference_number: Some("root".to_owned()),
                    name: "report.docx".to_owned(),
                    is_directory: false,
                    file_attributes: 0,
                    size_bytes: Some(24),
                    modified_at_utc_ms: Some(now),
                    last_usn: "3".to_owned(),
                    deleted_at_utc_ms: None,
                },
                IndexEntry {
                    file_reference_number: "binary".to_owned(),
                    parent_file_reference_number: Some("root".to_owned()),
                    name: "library.o".to_owned(),
                    is_directory: false,
                    file_attributes: 0,
                    size_bytes: Some(24),
                    modified_at_utc_ms: Some(now),
                    last_usn: "4".to_owned(),
                    deleted_at_utc_ms: None,
                },
                IndexEntry {
                    file_reference_number: "private-document".to_owned(),
                    parent_file_reference_number: Some("private".to_owned()),
                    name: "secret.md".to_owned(),
                    is_directory: false,
                    file_attributes: 0,
                    size_bytes: Some(24),
                    modified_at_utc_ms: Some(now),
                    last_usn: "5".to_owned(),
                    deleted_at_utc_ms: None,
                },
            ],
            events: vec![],
            checkpoint: UsnCheckpoint {
                usn_journal_id: "1".to_owned(),
                next_usn: "6".to_owned(),
                first_usn_seen: "1".to_owned(),
                record_major_version: 2,
                last_successful_sync_at_utc_ms: now,
            },
        })
        .expect("persist index page");

    let control = IndexerControlPlane::new(database.ntfs_index());
    let sid = "S-1-5-21-visible";
    let response = control.handle(
        sid,
        &request(IndexerRequestKind::Configure {
            allowed_roots: vec![display_path(&root)],
            excluded_roots: vec![display_path(&private)],
            file_categories: vec![FileCategory::Documents],
        }),
    );
    assert_eq!(response.status, "ready");

    let response = control.handle(
        sid,
        &request(IndexerRequestKind::ListToday {
            start_utc_ms: now - 1,
            end_utc_ms: now + 1,
        }),
    );
    assert_eq!(response.status, "ready");
    assert_eq!(response.candidates.len(), 1);
    assert!(
        response.candidates[0]
            .canonical_path
            .ends_with("report.docx")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn list_today_range_does_not_silently_truncate_more_than_five_thousand_files() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let root = std::env::current_dir()
        .expect("current directory")
        .join("target")
        .join(format!("qizhi-ntfs-unbounded-{nonce}"));
    std::fs::create_dir_all(&root).expect("create test root");
    let root = root.canonicalize().expect("canonical root");
    let database = Database::open(std::path::Path::new(":memory:")).expect("database opens");
    let volume = database
        .ntfs_index()
        .upsert_volume(&VolumeDescriptor {
            volume_guid: format!("unbounded-{nonce}"),
            current_mount_path: format!("{}\\", display_path(&root)),
            serial_number: None,
            file_system: "NTFS".to_owned(),
            state: VolumeState::Ready,
            state_message: None,
        })
        .expect("persist volume");
    let now = 1_700_000_000_000_i64;
    let mut entries = Vec::with_capacity(5_002);
    entries.push(IndexEntry {
        file_reference_number: "root".to_owned(),
        parent_file_reference_number: None,
        name: String::new(),
        is_directory: true,
        file_attributes: 0,
        size_bytes: None,
        modified_at_utc_ms: None,
        last_usn: "1".to_owned(),
        deleted_at_utc_ms: None,
    });
    entries.extend((0..5_001).map(|index| IndexEntry {
        file_reference_number: format!("file-{index}"),
        parent_file_reference_number: Some("root".to_owned()),
        name: format!("note-{index}.md"),
        is_directory: false,
        file_attributes: 0,
        size_bytes: Some(8),
        modified_at_utc_ms: Some(now),
        last_usn: format!("{}", index + 2),
        deleted_at_utc_ms: None,
    }));
    database
        .ntfs_index()
        .apply_page(&IndexPage {
            volume_id: volume.id,
            entries,
            events: vec![],
            checkpoint: UsnCheckpoint {
                usn_journal_id: "1".to_owned(),
                next_usn: "5003".to_owned(),
                first_usn_seen: "1".to_owned(),
                record_major_version: 2,
                last_successful_sync_at_utc_ms: now,
            },
        })
        .expect("persist large index page");

    let control = IndexerControlPlane::new(database.ntfs_index());
    let sid = "S-1-5-21-unbounded";
    assert_eq!(
        control
            .handle(
                sid,
                &request(IndexerRequestKind::Configure {
                    allowed_roots: vec![display_path(&root)],
                    excluded_roots: vec![],
                    file_categories: vec![FileCategory::Documents],
                }),
            )
            .status,
        "ready"
    );
    let response = control.handle(
        sid,
        &request(IndexerRequestKind::ListToday {
            start_utc_ms: now - 1,
            end_utc_ms: now + 1,
        }),
    );
    assert_eq!(response.status, "ready");
    assert_eq!(response.candidates.len(), 5_001);

    let _ = std::fs::remove_dir_all(root);
}
