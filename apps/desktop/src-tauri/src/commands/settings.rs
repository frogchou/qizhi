use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    config::{ConfigService, ServiceConfigurationInput, secret_store::WindowsCredentialStore},
    discovery::selector::select_discovery_with_paths,
    scan::{configuration::ScanRules, policy::ScanPolicy},
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
pub fn get_everything_status(state: State<'_, AppState>) -> EverythingStatus {
    let rules = match state.scan_rules.get() {
        Ok(value) => value,
        Err(_) => {
            return EverythingStatus {
                available: false,
                adapter: "unavailable".to_owned(),
                remediation: "无法读取本地扫描规则。".to_owned(),
            };
        }
    };
    let adapter = select_discovery_with_paths(
        rules.everything_sdk_path.map(std::path::PathBuf::from),
        rules.es_cli_path.map(std::path::PathBuf::from),
    );
    let health = adapter.health();
    EverythingStatus {
        available: health.available,
        adapter: health.adapter,
        remediation: health.remediation,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScanRulesInput {
    allowed_roots: Vec<String>,
    custom_exclusions: Vec<String>,
    everything_sdk_path: Option<String>,
    es_cli_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRulesOutput {
    allowed_roots: Vec<String>,
    custom_exclusions: Vec<String>,
    everything_sdk_path: Option<String>,
    es_cli_path: Option<String>,
    locked_exclusions: Vec<String>,
}

fn rules_output(value: ScanRules) -> ScanRulesOutput {
    ScanRulesOutput {
        allowed_roots: value.allowed_roots,
        custom_exclusions: value.custom_exclusions,
        everything_sdk_path: value.everything_sdk_path,
        es_cli_path: value.es_cli_path,
        locked_exclusions: ScanRules::default().locked_exclusions(),
    }
}

#[tauri::command]
pub fn list_scan_rules(state: State<'_, AppState>) -> Result<ScanRulesOutput, String> {
    state
        .scan_rules
        .get()
        .map(rules_output)
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn save_scan_rules(
    state: State<'_, AppState>,
    input: SaveScanRulesInput,
) -> Result<ScanRulesOutput, String> {
    let exclusions = input
        .custom_exclusions
        .iter()
        .map(std::path::PathBuf::from)
        .collect();
    let policy = ScanPolicy::new(exclusions);
    let roots = input
        .allowed_roots
        .iter()
        .map(std::path::PathBuf::from)
        .map(|root| policy.validate_root(&root))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.code().to_owned())?;
    if roots.is_empty() {
        return Err("invalid_config".to_owned());
    }
    state
        .scan_rules
        .save(ScanRules {
            allowed_roots: roots
                .into_iter()
                .map(|root| root.0.to_string_lossy().to_string())
                .collect(),
            custom_exclusions: input.custom_exclusions,
            everything_sdk_path: input.everything_sdk_path,
            es_cli_path: input.es_cli_path,
        })
        .map(rules_output)
        .map_err(|error| error.code().to_owned())
}
