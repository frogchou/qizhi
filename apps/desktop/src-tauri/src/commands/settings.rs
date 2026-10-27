use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    config::{ConfigService, ServiceConfigurationInput, secret_store::WindowsCredentialStore},
    discovery::port::FileDiscovery,
    discovery::unavailable::UnavailableDiscovery,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsInput {
    service: String,
    endpoint: String,
    api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskedSettingsOutput {
    service: String,
    endpoint: String,
    api_key_mask: String,
    credential_reference: String,
}

fn mask(config: crate::contracts::MaskedServiceConfig) -> MaskedSettingsOutput {
    MaskedSettingsOutput {
        service: config.service,
        endpoint: config.endpoint,
        api_key_mask: config.api_key_mask,
        credential_reference: config.credential_reference,
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Vec<MaskedSettingsOutput>, String> {
    state
        .database
        .configs()
        .list()
        .map(|configs| configs.into_iter().map(mask).collect())
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    input: SaveSettingsInput,
) -> Result<MaskedSettingsOutput, String> {
    let service = ConfigService::new(state.database.configs(), WindowsCredentialStore);
    service
        .save_masked(ServiceConfigurationInput {
            service: input.service,
            endpoint: input.endpoint,
            api_key: input.api_key,
        })
        .map(mask)
        .map_err(|error| error.code().to_owned())
}

#[derive(Serialize)]
pub struct ConnectionStatus {
    available: bool,
    message: String,
}

#[tauri::command]
pub fn test_service_connection(_state: State<'_, AppState>, _service: String) -> ConnectionStatus {
    ConnectionStatus {
        available: false,
        message: "连接测试将在相应功能阶段启用。".to_owned(),
    }
}

#[derive(Serialize)]
pub struct EverythingStatus {
    available: bool,
    adapter: String,
    remediation: String,
}

#[tauri::command]
pub fn get_everything_status() -> EverythingStatus {
    let health = UnavailableDiscovery.health();
    EverythingStatus {
        available: health.available,
        adapter: health.adapter,
        remediation: health.remediation,
    }
}
