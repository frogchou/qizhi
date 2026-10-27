use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::{
    config::{ConfigService, FakeSecretStore, ServiceConfigurationInput},
    database::Database,
    telemetry::redact_message,
};

fn temporary_database_path() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after epoch")
        .as_nanos();

    std::env::temp_dir().join(format!("qizhi-config-{nonce}.sqlite"))
}

#[test]
fn persists_only_a_masked_configuration_and_redacts_secret_text() {
    let path = temporary_database_path();
    let database = Database::open(&path).expect("database opens");
    let secrets = FakeSecretStore::default();
    let service = ConfigService::new(database.configs(), secrets.clone());
    let secret = "test-secret-never-persisted";

    let masked = service
        .save_masked(ServiceConfigurationInput {
            service: "openai".to_owned(),
            endpoint: "https://example.test/v1".to_owned(),
            api_key: secret.to_owned(),
        })
        .expect("configuration saves");

    assert_eq!(masked.endpoint, "https://example.test/v1");
    assert_eq!(masked.api_key_mask, "••••••••");
    assert!(secrets.contains("qizhi/openai/default"));
    assert!(
        !database
            .debug_values()
            .expect("database values read")
            .contains(secret)
    );
    assert!(!redact_message(&format!("request failed: {secret}")).contains(secret));

    let _ = std::fs::remove_file(path);
}

#[test]
fn rejects_a_service_endpoint_without_http_or_https() {
    let path = temporary_database_path();
    let database = Database::open(&path).expect("database opens");
    let service = ConfigService::new(database.configs(), FakeSecretStore::default());

    let error = service
        .save_masked(ServiceConfigurationInput {
            service: "openai".to_owned(),
            endpoint: "file:///C:/private".to_owned(),
            api_key: "test-secret".to_owned(),
        })
        .expect_err("file endpoints are invalid");

    assert_eq!(error.code(), "invalid_config");

    let _ = std::fs::remove_file(path);
}
