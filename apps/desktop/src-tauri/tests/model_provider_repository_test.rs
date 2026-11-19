use qizhi_desktop_lib::{
    contracts::{
        MaskedServiceConfig, ModelProviderConfig, SummaryPromptTemplateInput, SummarySettingsInput,
    },
    database::Database,
};

fn database() -> Database {
    Database::open(std::path::Path::new(":memory:")).expect("database")
}

#[test]
fn migrates_the_existing_openai_configuration_as_the_only_active_provider() {
    let db = database();
    db.configs()
        .save(&MaskedServiceConfig {
            service: "openai".into(),
            endpoint: "https://proxy.example.test".into(),
            credential_reference: "qizhi/openai/default".into(),
            api_key_mask: "••••••••".into(),
        })
        .expect("legacy config");
    let summary = db.summary_settings().get().expect("summary settings");
    db.summary_settings()
        .save(&SummarySettingsInput {
            model: "gpt-test-summary".into(),
            templates: summary
                .templates
                .into_iter()
                .map(|item| SummaryPromptTemplateInput {
                    id: Some(item.id),
                    title: item.title,
                    prompt: item.prompt,
                    sort_order: item.sort_order,
                    is_default: item.is_default,
                })
                .collect(),
        })
        .expect("legacy summary model");

    db.model_providers()
        .migrate_legacy_openai()
        .expect("migrate legacy provider");

    let active = db
        .model_providers()
        .active()
        .expect("active query")
        .expect("active provider");
    assert_eq!(active.provider_id, "openai");
    assert_eq!(active.endpoint, "https://proxy.example.test/v1");
    assert_eq!(active.model, "gpt-test-summary");
    assert_eq!(active.credential_reference, "qizhi/openai/default");
}

#[test]
fn saving_does_not_activate_but_explicit_activation_is_unique() {
    let db = database();
    let repository = db.model_providers();
    repository
        .save(&ModelProviderConfig {
            provider_id: "openai".into(),
            display_name: "OpenAI".into(),
            endpoint: "https://api.openai.com/v1".into(),
            model: "gpt-test".into(),
            credential_reference: "qizhi/model-provider/openai".into(),
            api_key_mask: "••••••••".into(),
            supports_responses: true,
            is_active: false,
            updated_at_utc_ms: 1,
        })
        .expect("save openai");
    repository.activate("openai").expect("activate openai");
    repository
        .save(&ModelProviderConfig {
            provider_id: "qwen".into(),
            display_name: "阿里云百炼 / 千问".into(),
            endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            model: "qwen-plus".into(),
            credential_reference: "qizhi/model-provider/qwen".into(),
            api_key_mask: "••••••••".into(),
            supports_responses: false,
            is_active: false,
            updated_at_utc_ms: 2,
        })
        .expect("save qwen");

    assert_eq!(repository.active().unwrap().unwrap().provider_id, "openai");
    repository.activate("qwen").expect("activate qwen");
    let providers = repository.list().expect("providers");
    assert_eq!(providers.iter().filter(|item| item.is_active).count(), 1);
    assert_eq!(repository.active().unwrap().unwrap().provider_id, "qwen");
}
