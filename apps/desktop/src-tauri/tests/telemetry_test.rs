use std::{fs, time::{SystemTime, UNIX_EPOCH}};

use qizhi_desktop_lib::telemetry::{redact_message, AppLogger};

#[test]
fn diagnostic_log_redacts_credentials_before_writing() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!("qizhi-log-test-{nonce}"));
    let logger = AppLogger::new(&directory);
    let secret = "sk-not-for-diagnostics";

    logger.error("ragflow", &format!("connection rejected: {secret}"));

    let content = fs::read_to_string(logger.current_log_path()).expect("diagnostic log exists");
    assert!(content.contains("[REDACTED]"));
    assert!(!content.contains(secret));
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn redaction_keeps_operational_message_but_hides_known_key_prefixes() {
    assert_eq!(
        redact_message("today scan failed with apikey_sensitive"),
        "today scan failed with [REDACTED]"
    );
}
