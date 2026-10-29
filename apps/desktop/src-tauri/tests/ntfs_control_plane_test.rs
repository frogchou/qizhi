use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    database::Database,
    ntfs::{
        IndexerControlPlane,
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
