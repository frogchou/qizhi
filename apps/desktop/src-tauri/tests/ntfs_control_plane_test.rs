use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    database::Database,
    ntfs::{
        CallerIndexPolicy, IndexExecutor, IndexerControlPlane,
        ipc::{INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind},
    },
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
