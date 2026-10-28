use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

use crate::{
    app_state::AppState,
    config::{ConfigService, ServiceConfigurationInput, secret_store::WindowsCredentialStore},
    discovery::selector::select_discovery_with_paths,
    network::http::HttpClient,
    scan::{
        configuration::ScanRules,
        file_filter::{FileCategory, default_file_categories},
        policy::ScanPolicy,
    },
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
pub fn test_service_connection(input: SaveSettingsInput) -> ConnectionStatus {
    if !matches!(input.service.as_str(), "openai" | "ragflow")
        || input.api_key.trim().is_empty()
        || input.api_key.contains(['\r', '\n', '"'])
    {
        return ConnectionStatus {
            available: false,
            message: "请先填写服务 Base URL 和 API Key。".to_owned(),
        };
    }
    let Ok(mut base_url) = url::Url::parse(input.endpoint.trim()) else {
        return ConnectionStatus {
            available: false,
            message: "Base URL 格式不正确。".to_owned(),
        };
    };
    let base_path = base_url.path().trim_end_matches('/');
    match input.service.as_str() {
        "openai" => base_url.set_path(&format!("{base_path}/models")),
        "ragflow" => {
            base_url.set_path(&format!("{base_path}/api/v1/chats"));
            base_url.set_query(Some("page=1&page_size=1"));
        }
        _ => unreachable!("service validated above"),
    }
    match HttpClient::with_timeout(Duration::from_secs(10)).and_then(|client| {
        client.request_bearer(
            reqwest::Method::GET,
            base_url.as_str(),
            &input.api_key,
            None,
        )
    }) {
        Ok(response) => {
            let status = response.status.to_string();
            if connection_is_usable(&input.service, &status, &response.body) {
                return ConnectionStatus {
                    available: true,
                    message: match input.service.as_str() {
                        "openai" => "OpenAI API 连接正常。".to_owned(),
                        "ragflow" => "RAGFlow API 连接正常。".to_owned(),
                        _ => unreachable!("service validated above"),
                    },
                };
            }
            ConnectionStatus {
                available: false,
                message: format!(
                    "连接未通过{}。",
                    status
                        .strip_prefix('0')
                        .map(|code| format!("（HTTP {code}）"))
                        .unwrap_or_default()
                ),
            }
        }
        Err(message) => ConnectionStatus {
            available: false,
            message,
        },
    }
}

fn connection_is_usable(service: &str, status: &str, body: &str) -> bool {
    if status != "200" {
        return false;
    }
    service != "ragflow"
        || serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("code").and_then(serde_json::Value::as_i64))
            == Some(0)
}

#[cfg(test)]
mod tests {
    use super::connection_is_usable;

    #[test]
    fn connection_tests_do_not_delegate_http_to_curl() {
        let source = include_str!("settings.rs").to_ascii_lowercase();
        assert!(!source.contains(&["curl", ".exe"].concat()));
    }

    #[test]
    fn folder_selection_never_starts_a_command_shell() {
        let source = include_str!("settings.rs").to_ascii_lowercase();
        assert!(!source.contains(&["power", "shell.exe"].concat()));
    }

    #[test]
    fn rejects_a_ragflow_business_error_with_an_http_success_status() {
        assert!(!connection_is_usable(
            "ragflow",
            "200",
            r#"{"code":102,"message":"API key is invalid"}"#,
        ));
        assert!(connection_is_usable(
            "ragflow",
            "200",
            r#"{"code":0,"message":"success","data":[]}"#,
        ));
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
        Some(state.everything_sdk_path.clone()),
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
    #[serde(default = "default_file_categories")]
    file_categories: Vec<FileCategory>,
    es_cli_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRulesOutput {
    allowed_roots: Vec<String>,
    custom_exclusions: Vec<String>,
    file_categories: Vec<FileCategory>,
    everything_sdk_path: Option<String>,
    es_cli_path: Option<String>,
    locked_exclusions: Vec<String>,
}

fn rules_output(value: ScanRules) -> ScanRulesOutput {
    ScanRulesOutput {
        allowed_roots: value.allowed_roots,
        custom_exclusions: value.custom_exclusions,
        file_categories: value.file_categories,
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
            file_categories: input.file_categories,
            everything_sdk_path: None,
            es_cli_path: input.es_cli_path,
        })
        .map(rules_output)
        .map_err(|error| error.code().to_owned())
}
