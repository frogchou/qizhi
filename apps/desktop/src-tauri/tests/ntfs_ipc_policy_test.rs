use qizhi_desktop_lib::ntfs::ipc::{
    INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind, IpcAuthorizationPolicy,
    IpcValidationError, validate_request,
};
use qizhi_desktop_lib::ntfs::pipe::handle_request_bytes;

#[cfg(windows)]
#[test]
#[ignore = "requires a UAC-installed QizhiNtfsIndexer service; run with --ignored on a Windows integration machine"]
fn connects_to_a_real_local_indexer_pipe_when_explicitly_enabled() {
    let response = qizhi_desktop_lib::ntfs::pipe::call_indexer_service(&IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: "real-pipe-health".to_owned(),
        kind: IndexerRequestKind::Health,
    })
    .expect("a locally installed indexer service responds");
    assert_eq!(response.status, "ready");
}

fn policy() -> IpcAuthorizationPolicy {
    IpcAuthorizationPolicy {
        caller_sid: "S-1-5-21-100".to_owned(),
        allowed_roots: vec![r"D:\work".to_owned(), r"C:\Users\fcc\Documents".to_owned()],
    }
}

fn build(roots: Vec<&str>) -> IndexerRequest {
    let _ = roots;
    IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: "request-1".to_owned(),
        kind: IndexerRequestKind::Build,
    }
}

#[test]
fn accepts_an_authenticated_request_with_a_saved_authorized_scope() {
    assert_eq!(
        validate_request(&policy(), "S-1-5-21-100", &build(vec![])),
        Ok(())
    );
}

#[test]
fn rejects_unsupported_versions_and_untrusted_sids() {
    let unsupported = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION + 1,
        request_id: "request-1".to_owned(),
        kind: IndexerRequestKind::Health,
    };
    assert_eq!(
        validate_request(&policy(), "S-1-5-21-100", &unsupported),
        Err(IpcValidationError::UnsupportedProtocol)
    );
    assert_eq!(
        validate_request(&policy(), "S-1-5-21-999", &build(vec![r"D:\work"])),
        Err(IpcValidationError::UnauthorizedCaller)
    );
}

#[test]
fn rejects_missing_or_empty_configured_scan_roots() {
    let missing = IpcAuthorizationPolicy {
        caller_sid: "S-1-5-21-100".to_owned(),
        allowed_roots: vec![],
    };
    assert_eq!(
        validate_request(&missing, "S-1-5-21-100", &build(vec![])),
        Err(IpcValidationError::MissingAuthorizedRoots)
    );
    let configure = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: "configure-1".to_owned(),
        kind: IndexerRequestKind::Configure {
            allowed_roots: vec!["".to_owned()],
            excluded_roots: vec![],
            file_categories: vec![],
        },
    };
    assert_eq!(
        validate_request(&policy(), "S-1-5-21-100", &configure),
        Err(IpcValidationError::EmptyRoot)
    );
}

#[test]
fn rejects_more_than_the_bounded_number_of_roots() {
    let roots = (0..65).map(|_| r"D:\work".to_owned()).collect();
    let configure = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: "configure-1".to_owned(),
        kind: IndexerRequestKind::Configure {
            allowed_roots: roots,
            excluded_roots: vec![],
            file_categories: vec![],
        },
    };
    assert_eq!(
        validate_request(&policy(), "S-1-5-21-100", &configure),
        Err(IpcValidationError::TooManyRoots)
    );
}

#[test]
fn service_protocol_refuses_index_requests_until_the_pipe_identity_is_configured() {
    let response: serde_json::Value = serde_json::from_slice(&handle_request_bytes(
        &serde_json::to_vec(&build(vec![])).expect("request encodes"),
    ))
    .expect("response decodes");

    assert_eq!(response["status"], "rejected");
    assert_eq!(response["message"], "本地索引服务尚未完成授权配置");
}

#[test]
fn service_protocol_supports_a_bounded_health_handshake() {
    let request = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: "health-1".to_owned(),
        kind: IndexerRequestKind::Health,
    };
    let response: serde_json::Value = serde_json::from_slice(&handle_request_bytes(
        &serde_json::to_vec(&request).expect("request encodes"),
    ))
    .expect("response decodes");

    assert_eq!(response["status"], "ready");
    assert_eq!(response["request_id"], "health-1");
}
