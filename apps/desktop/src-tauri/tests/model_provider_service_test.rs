use qizhi_desktop_lib::{
    config::{
        FakeSecretStore, ModelProviderSaveInput, ModelProviderService, SecretStore,
        model_provider_presets,
    },
    database::Database,
};

fn service() -> (ModelProviderService<FakeSecretStore>, FakeSecretStore) {
    let database = Database::open(std::path::Path::new(":memory:")).expect("database");
    let secrets = FakeSecretStore::default();
    (
        ModelProviderService::new(database.model_providers(), secrets.clone()),
        secrets,
    )
}

#[test]
fn exposes_the_supported_provider_presets() {
    let presets = model_provider_presets();
    assert_eq!(
        presets
            .iter()
            .map(|item| item.provider_id)
            .collect::<Vec<_>>(),
        vec![
            "openai", "deepseek", "qwen", "moonshot", "zhipu", "minimax", "ollama", "custom"
        ]
    );
    assert_eq!(
        presets
            .iter()
            .find(|item| item.provider_id == "ollama")
            .unwrap()
            .default_endpoint,
        "http://localhost:11434/v1"
    );
    assert!(
        !presets
            .iter()
            .find(|item| item.provider_id == "qwen")
            .unwrap()
            .supports_responses
    );
}

#[test]
fn remote_providers_require_a_key_but_ollama_does_not() {
    let (service, _) = service();
    let remote = service.save(ModelProviderSaveInput {
        provider_id: "qwen".into(),
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
        model: "qwen-plus".into(),
        api_key: String::new(),
        supports_responses: None,
    });
    assert!(remote.is_err());

    let ollama = service
        .save(ModelProviderSaveInput {
            provider_id: "ollama".into(),
            endpoint: "http://localhost:11434/v1".into(),
            model: "qwen3:8b".into(),
            api_key: String::new(),
            supports_responses: None,
        })
        .expect("keyless ollama");
    assert_eq!(ollama.provider_id, "ollama");
    assert!(ollama.credential_reference.is_empty());
}

#[test]
fn blank_key_keeps_the_existing_saved_secret() {
    let (service, secrets) = service();
    service
        .save(ModelProviderSaveInput {
            provider_id: "openai".into(),
            endpoint: "https://proxy.example.test/v1/".into(),
            model: "gpt-first".into(),
            api_key: "secret-one".into(),
            supports_responses: None,
        })
        .expect("first save");
    let updated = service
        .save(ModelProviderSaveInput {
            provider_id: "openai".into(),
            endpoint: "https://proxy.example.test/v1".into(),
            model: "gpt-second".into(),
            api_key: String::new(),
            supports_responses: None,
        })
        .expect("blank key retains secret");

    assert_eq!(updated.model, "gpt-second");
    assert_eq!(
        secrets.get(&updated.credential_reference).unwrap(),
        "secret-one"
    );
}

#[test]
fn rejects_unknown_providers_and_non_http_endpoints() {
    let (service, _) = service();
    for input in [
        ModelProviderSaveInput {
            provider_id: "unknown".into(),
            endpoint: "https://example.test/v1".into(),
            model: "model".into(),
            api_key: "secret".into(),
            supports_responses: None,
        },
        ModelProviderSaveInput {
            provider_id: "custom".into(),
            endpoint: "file:///tmp/model".into(),
            model: "model".into(),
            api_key: "secret".into(),
            supports_responses: Some(false),
        },
    ] {
        assert!(service.save(input).is_err());
    }
}
