use qizhi_desktop_lib::codex::{JsonLineFramer, JsonRpcEnvelope};

#[test]
fn frames_multiple_messages_and_preserves_a_partial_tail() {
    let mut framer = JsonLineFramer::new(1024);
    let first = framer
        .push(
            br#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}
{"method":"item/started","params":{"id":"a"}}"#,
        )
        .unwrap();
    assert_eq!(first.len(), 1);
    let second = framer.push(b"\n").unwrap();
    assert_eq!(second.len(), 1);
    assert!(matches!(
        JsonRpcEnvelope::parse(&first[0]).unwrap(),
        JsonRpcEnvelope::Response { id: 1, .. }
    ));
    assert!(
        matches!(JsonRpcEnvelope::parse(&second[0]).unwrap(), JsonRpcEnvelope::Notification { method, .. } if method == "item/started")
    );
}

#[test]
fn distinguishes_success_error_and_unknown_notifications() {
    assert!(matches!(
        JsonRpcEnvelope::parse(r#"{"id":9,"error":{"code":-1,"message":"bad"}}"#).unwrap(),
        JsonRpcEnvelope::Response {
            id: 9,
            error: Some(_),
            ..
        }
    ));
    assert!(
        matches!(JsonRpcEnvelope::parse(r#"{"method":"future/event","params":{"value":1}}"#).unwrap(), JsonRpcEnvelope::Notification { method, .. } if method == "future/event")
    );
    assert!(JsonRpcEnvelope::parse("not json").is_err());
    assert!(
        matches!(JsonRpcEnvelope::parse(r#"{"id":"approval-1","method":"item/fileChange/requestApproval","params":{}}"#).unwrap(), JsonRpcEnvelope::ServerRequest { id, .. } if id == serde_json::json!("approval-1"))
    );
}

#[test]
fn rejects_an_oversized_unterminated_line() {
    let mut framer = JsonLineFramer::new(8);
    assert!(framer.push(b"123456789").is_err());
}
