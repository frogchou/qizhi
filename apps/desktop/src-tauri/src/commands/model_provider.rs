use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    config::{
        ModelProviderSaveInput, ModelProviderService, model_provider_presets,
        secret_store::SystemCredentialStore,
    },
    contracts::ModelProviderConfig,
    network::http::HttpClient,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelProviderInput {
    pub provider_id: String,
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    pub supports_responses: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestModelProviderInput {
    pub provider_id: String,
    pub endpoint: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateModelProviderInput {
    pub provider_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConnectionStatus {
    pub available: bool,
    pub message: String,
}

fn service(state: &AppState) -> ModelProviderService<SystemCredentialStore> {
    ModelProviderService::new(state.database.model_providers(), SystemCredentialStore)
}

#[tauri::command]
pub fn list_model_providers(
    state: State<'_, AppState>,
) -> Result<Vec<ModelProviderConfig>, String> {
    service(&state)
        .list()
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn save_model_provider(
    state: State<'_, AppState>,
    input: SaveModelProviderInput,
) -> Result<ModelProviderConfig, String> {
    service(&state)
        .save(ModelProviderSaveInput {
            provider_id: input.provider_id,
            endpoint: input.endpoint,
            model: input.model,
            api_key: input.api_key,
            supports_responses: input.supports_responses,
        })
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn activate_model_provider(
    state: State<'_, AppState>,
    input: ActivateModelProviderInput,
) -> Result<ModelProviderConfig, String> {
    service(&state)
        .activate(&input.provider_id)
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn get_active_model_provider(
    state: State<'_, AppState>,
) -> Result<Option<ModelProviderConfig>, String> {
    service(&state)
        .active()
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn test_model_provider(
    state: State<'_, AppState>,
    input: TestModelProviderInput,
) -> ModelProviderConnectionStatus {
    let Some(preset) = model_provider_presets()
        .iter()
        .find(|preset| preset.provider_id == input.provider_id.trim())
    else {
        return failed("不支持的模型服务商。");
    };
    let Ok(url) = model_api_url(&input.endpoint, "chat/completions") else {
        return failed("Base URL 格式不正确。");
    };
    let Ok(body) = build_connection_test_body(&input.model) else {
        return failed("请填写模型名称。");
    };

    let provider_service = service(&state);
    let saved_config = provider_service.list().ok().and_then(|items| {
        items
            .into_iter()
            .find(|item| item.provider_id == preset.provider_id)
    });
    let supplied_key = input.api_key.trim();
    let saved_key = if supplied_key.is_empty() {
        saved_config
            .as_ref()
            .and_then(|config| provider_service.resolve_api_key(config).ok().flatten())
    } else {
        None
    };
    let api_key = if supplied_key.is_empty() {
        saved_key.as_deref()
    } else {
        Some(supplied_key)
    };
    if preset.requires_api_key && api_key.is_none() {
        return failed("请填写 API Key，或先保存已有凭据。");
    }

    match HttpClient::with_timeout(Duration::from_secs(30))
        .and_then(|client| client.request_json(reqwest::Method::POST, &url, api_key, Some(body)))
    {
        Ok(response) if (200..300).contains(&response.status) => ModelProviderConnectionStatus {
            available: true,
            message: format!("{} 连接正常，模型可用。", preset.display_name),
        },
        Ok(response) => failed(&format!(
            "{} 连接未通过（HTTP {}）。请检查模型名称、API Key 与服务权限。",
            preset.display_name, response.status
        )),
        Err(message) => failed(&message),
    }
}

pub fn model_api_url(base: &str, suffix: &str) -> Result<String, String> {
    let mut url = url::Url::parse(base.trim()).map_err(|_| "invalid_url".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("invalid_url".to_owned());
    }
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/{}", suffix.trim_start_matches('/')));
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

pub fn build_connection_test_body(model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("invalid_model".to_owned());
    }
    serde_json::to_string(&serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}],
        "stream": false,
        "max_tokens": 1
    }))
    .map_err(|_| "invalid_body".to_owned())
}

fn failed(message: &str) -> ModelProviderConnectionStatus {
    ModelProviderConnectionStatus {
        available: false,
        message: message.to_owned(),
    }
}
