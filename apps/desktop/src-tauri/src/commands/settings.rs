use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

use crate::{
    app_state::AppState,
    config::{ConfigService, ServiceConfigurationInput, secret_store::WindowsCredentialStore},
    network::http::HttpClient,
    ntfs::{
        ipc::{INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind},
        pipe::call_indexer_service,
    },
    scan::{
        configuration::{
            ScanRules, default_directory_group_threshold, validate_directory_group_threshold,
        },
        file_filter::{FileCategory, default_file_categories},
        policy::{ScanPolicy, active_roots, display_path},
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
pub fn get_ntfs_indexer_status() -> ConnectionStatus {
    let request = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: format!("desktop-health-{}", chrono::Utc::now().timestamp_millis()),
        kind: IndexerRequestKind::Health,
    };
    local_indexer_connection_status(call_indexer_service(&request))
}

fn local_indexer_connection_status(
    result: Result<crate::ntfs::ipc::IndexerResponse, String>,
) -> ConnectionStatus {
    match result {
        Ok(response) if response.status == "ready" => ConnectionStatus {
            available: true,
            message: "本地 NTFS 索引服务已连接。".to_owned(),
        },
        Ok(response) => ConnectionStatus {
            available: false,
            message: response
                .message
                .unwrap_or_else(|| "本地 NTFS 索引服务暂不可用。".to_owned()),
        },
        Err(message) => ConnectionStatus {
            available: false,
            message,
        },
    }
}

fn configure_local_indexer(rules: &ScanRules) -> Result<(), String> {
    let exclusions = rules
        .custom_exclusions
        .iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    let roots = active_roots(&rules.allowed_roots, &exclusions)
        .map_err(|_| "扫描目录无效，请在设置中重新保存。".to_owned())?;
    let request = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: format!(
            "desktop-configure-{}",
            chrono::Utc::now().timestamp_millis()
        ),
        kind: IndexerRequestKind::Configure {
            allowed_roots: roots.iter().map(|root| display_path(&root.0)).collect(),
            excluded_roots: rules.custom_exclusions.clone(),
            file_categories: rules.file_categories.clone(),
        },
    };
    match call_indexer_service(&request) {
        Ok(response) if response.status == "ready" => Ok(()),
        Ok(response) => Err(response
            .message
            .unwrap_or_else(|| "本地 NTFS 索引服务拒绝了扫描范围".to_owned())),
        Err(message) => Err(message),
    }
}

#[tauri::command]
pub fn test_service_connection(input: SaveSettingsInput) -> ConnectionStatus {
    if !matches!(input.service.as_str(), "openai" | "ragflow" | "jev")
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
    let (method, body) = match input.service.as_str() {
        "openai" => {
            base_url.set_path(&format!("{base_path}/models"));
            (reqwest::Method::GET, None)
        }
        "ragflow" => {
            base_url.set_path(&format!("{base_path}/api/v1/chats"));
            base_url.set_query(Some("page=1&page_size=1"));
            (reqwest::Method::GET, None)
        }
        "jev" => {
            // Listing models alone is not enough: a proxy can permit GET
            // requests while blocking the POST request used for JEV scoring.
            base_url.set_path(&format!("{base_path}/v1/systemone"));
            (
                reqwest::Method::POST,
                Some(
                    serde_json::json!({
                        "model": "jev-latest",
                        "state": "JEV connection test",
                        "questions": {
                            "connection": {
                                "type": "noul",
                                "instructions": "Is this a JEV connection test?"
                            }
                        }
                    })
                    .to_string(),
                ),
            )
        }
        _ => unreachable!("service validated above"),
    };
    match HttpClient::with_timeout(Duration::from_secs(10))
        .and_then(|client| client.request_bearer(method, base_url.as_str(), &input.api_key, body))
    {
        Ok(response) => {
            let status = response.status.to_string();
            if connection_is_usable(&input.service, &status, &response.body) {
                return ConnectionStatus {
                    available: true,
                    message: match input.service.as_str() {
                        "openai" => "OpenAI API 连接正常。".to_owned(),
                        "ragflow" => "RAGFlow API 连接正常。".to_owned(),
                        "jev" => "TypeSafe AI / JEV 连接正常。".to_owned(),
                        _ => unreachable!("service validated above"),
                    },
                };
            }
            ConnectionStatus {
                available: false,
                message: connection_failure_message(&input.service, response.status),
            }
        }
        Err(message) => ConnectionStatus {
            available: false,
            message,
        },
    }
}

fn connection_failure_message(service: &str, status: u16) -> String {
    if service == "jev" && status == 451 {
        return "JEV 价值评估请求被拒绝（HTTP 451）。请确认网络或代理允许访问 TypeSafe AI 的 /v1/systemone 接口。".to_owned();
    }
    format!("连接未通过（HTTP {status}）。")
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
    use super::{
        connection_failure_message, connection_is_usable, local_indexer_connection_status,
    };
    use crate::ntfs::ipc::{INDEXER_PROTOCOL_VERSION, IndexerResponse};

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

    #[test]
    fn explains_when_jev_inference_is_blocked_upstream() {
        assert_eq!(
            connection_failure_message("jev", 451),
            "JEV 价值评估请求被拒绝（HTTP 451）。请确认网络或代理允许访问 TypeSafe AI 的 /v1/systemone 接口。"
        );
    }

    #[test]
    fn reports_a_healthy_local_indexer_without_falling_back_to_file_scanning() {
        let status = local_indexer_connection_status(Ok(IndexerResponse {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: "health-1".to_owned(),
            status: "ready".to_owned(),
            message: None,
            candidates: vec![],
        }));
        assert!(status.available);
        assert!(status.message.contains("NTFS"));
    }

    #[test]
    fn scan_scope_sync_uses_the_local_indexer_protocol_instead_of_a_shell() {
        let source = include_str!("settings.rs").to_ascii_lowercase();
        assert!(source.contains("indexerrequestkind::configure"));
        assert!(!source.contains(&["power", "shell.exe"].concat()));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScanRulesInput {
    allowed_roots: Vec<String>,
    custom_exclusions: Vec<String>,
    #[serde(default = "default_file_categories")]
    file_categories: Vec<FileCategory>,
    #[serde(default = "default_directory_group_threshold")]
    directory_group_threshold: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRulesOutput {
    allowed_roots: Vec<String>,
    custom_exclusions: Vec<String>,
    file_categories: Vec<FileCategory>,
    directory_group_threshold: u16,
    locked_exclusions: Vec<String>,
}

fn rules_output(value: ScanRules) -> ScanRulesOutput {
    ScanRulesOutput {
        allowed_roots: value.allowed_roots,
        custom_exclusions: value.custom_exclusions,
        file_categories: value.file_categories,
        directory_group_threshold: value.directory_group_threshold,
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
    validate_directory_group_threshold(input.directory_group_threshold)
        .map_err(|error| error.code().to_owned())?;
    let previous = state
        .scan_rules
        .get()
        .map_err(|error| error.code().to_owned())?;
    let policy = ScanPolicy::new(vec![]);
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
    let saved = state
        .scan_rules
        .save(ScanRules {
            allowed_roots: roots
                .into_iter()
                .map(|root| display_path(&root.0))
                .collect(),
            custom_exclusions: input.custom_exclusions,
            file_categories: input.file_categories,
            directory_group_threshold: input.directory_group_threshold,
        })
        .map_err(|error| error.code().to_owned())?;
    if indexer_fields_changed(&previous, &saved) {
        match configure_local_indexer(&saved) {
            Ok(()) => state
                .logger
                .info("ntfs-indexer", "scan scope synchronized to local indexer"),
            Err(error) => state.logger.error(
                "ntfs-indexer",
                &format!("scan scope saved locally but indexer synchronization failed: {error}"),
            ),
        }
    }
    Ok(rules_output(saved))
}

pub fn indexer_fields_changed(previous: &ScanRules, next: &ScanRules) -> bool {
    previous.allowed_roots != next.allowed_roots
        || previous.custom_exclusions != next.custom_exclusions
        || previous.file_categories != next.file_categories
}
