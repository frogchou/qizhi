use qizhi_desktop_lib::{
    config::{ConfigService, FakeSecretStore, SecretStore, ServiceConfigurationInput},
    database::Database,
    telemetry::redact_message,
};

#[test]
fn stores_a_ragflow_key_only_in_the_secret_store() {
    let temporary = tempfile::tempdir().expect("test directory");
    let database = Database::open(&temporary.path().join("qizhi.sqlite")).expect("database opens");
    let secrets = FakeSecretStore::default();
    let service = ConfigService::new(database.configs(), secrets.clone());
    let secret = "ragflow-secret-never-persisted";

    let masked = service
        .save_masked(ServiceConfigurationInput {
            service: "ragflow".to_owned(),
            endpoint: "http://ragflow.example.test".to_owned(),
            api_key: secret.to_owned(),
        })
        .expect("RAGFlow configuration saves");

    assert_eq!(masked.credential_reference, "qizhi/ragflow/default");
    assert_eq!(
        secrets.get("qizhi/ragflow/default").expect("secret reads"),
        secret
    );
    assert!(
        !database
            .debug_values()
            .expect("database values read")
            .contains(secret)
    );
}

#[test]
fn persists_only_a_masked_configuration_and_redacts_secret_text() {
    let temporary = tempfile::tempdir().expect("test directory");
    let database = Database::open(&temporary.path().join("qizhi.sqlite")).expect("database opens");
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
}

#[test]
fn rejects_a_service_endpoint_without_http_or_https() {
    let temporary = tempfile::tempdir().expect("test directory");
    let database = Database::open(&temporary.path().join("qizhi.sqlite")).expect("database opens");
    let service = ConfigService::new(database.configs(), FakeSecretStore::default());

    let error = service
        .save_masked(ServiceConfigurationInput {
            service: "openai".to_owned(),
            endpoint: "file:///C:/private".to_owned(),
            api_key: "test-secret".to_owned(),
        })
        .expect_err("file endpoints are invalid");

    assert_eq!(error.code(), "invalid_config");
}
