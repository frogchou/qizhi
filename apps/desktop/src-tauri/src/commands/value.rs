use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{LazyLock, Mutex},
};

use serde::Serialize;
use tauri::State;

use super::today::WorkspaceScope;
use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    contracts::{FileRecord, FileValueAssessmentInput, JevValuePolicy, JevValuePolicyInput},
    jev::{JevClient, ValueDocument, extract_value_text},
    scan::{file_filter::FileTypeFilter, policy::ScanPolicy},
};

const VALUE_BATCH_SIZE: usize = 8;

// An assessment is cached by the immutable version identity below. The process-wide
// guard closes the short gap before the persisted cache is written when a page
// refresh and a view change happen at the same time.
static IN_FLIGHT_VALUE_ASSESSMENTS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileValueOutput {
    file_id: i64,
    status: String,
    score: Option<f64>,
    confidence: Option<f64>,
    message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEvaluationOutput {
    evaluated: usize,
    valuable: usize,
    not_valuable: usize,
    failed: usize,
    unsupported: usize,
    failure_message: Option<String>,
}

#[tauri::command]
pub fn get_jev_value_policy(state: State<'_, AppState>) -> Result<JevValuePolicy, String> {
    state
        .database
        .jev_value_policy()
        .get()
        .map_err(|_| "无法读取 JEV 价值评估标准。".to_owned())
}

#[tauri::command]
pub fn save_jev_value_policy(
    state: State<'_, AppState>,
    input: JevValuePolicyInput,
) -> Result<JevValuePolicy, String> {
    state
        .database
        .jev_value_policy()
        .save(&input)
        .map_err(|_| {
            "评估标准无效：说明不能为空，分级需要 2—10 项，阈值必须位于最低分和最高分之间。"
                .to_owned()
        })?;
    let saved = state
        .database
        .jev_value_policy()
        .get()
        .map_err(|_| "评估标准已保存，但无法重新读取。".to_owned())?;
    state.logger.info(
        "jev",
        &format!(
            "JEV value policy saved with {} criteria and threshold {}",
            saved.criteria.len(),
            saved.valuable_threshold
        ),
    );
    Ok(saved)
}

#[tauri::command]
pub async fn evaluate_today_files(
    state: State<'_, AppState>,
    file_ids: Vec<i64>,
) -> Result<Vec<FileValueOutput>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || evaluate(&state, file_ids))
        .await
        .map_err(|_| "JEV 价值评估发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn evaluate_workspace_query(
    state: State<'_, AppState>,
    query_id: String,
    scope: WorkspaceScope,
) -> Result<WorkspaceEvaluationOutput, String> {
    if !allows_automatic_workspace_evaluation(scope) {
        return Err("过去文件不会自动进行 JEV 价值评估。请勾选文件后手动评估。".to_owned());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || evaluate_workspace(&state, &query_id))
        .await
        .map_err(|_| "JEV 目录价值评估发生意外错误。".to_owned())?
}

fn allows_automatic_workspace_evaluation(scope: WorkspaceScope) -> bool {
    matches!(scope, WorkspaceScope::Today)
}

fn is_final_assessment_status(status: &str) -> bool {
    matches!(
        status,
        "valuable" | "not_valuable" | "unsupported" | "error"
    )
}

fn assessment_key(file: &FileRecord) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        file.canonical_path.to_ascii_lowercase(),
        file.file_identity,
        file.modified_at_utc_ms
    )
}

fn claim_value_assessment(file: &FileRecord) -> bool {
    IN_FLIGHT_VALUE_ASSESSMENTS
        .lock()
        .map(|mut assessments| assessments.insert(assessment_key(file)))
        .unwrap_or(false)
}

fn release_value_assessment(file: &FileRecord) {
    if let Ok(mut assessments) = IN_FLIGHT_VALUE_ASSESSMENTS.lock() {
        assessments.remove(&assessment_key(file));
    }
}

struct PendingValueAssessmentClaims(Vec<FileRecord>);

impl Drop for PendingValueAssessmentClaims {
    fn drop(&mut self) {
        for file in &self.0 {
            release_value_assessment(file);
        }
    }
}

pub fn workspace_evaluation_candidate_ids(
    state: &AppState,
    query_id: &str,
) -> Result<Vec<i64>, String> {
    let ids = state.workspace_queries.all_visible_file_ids(query_id)?;
    let (roots, exclusions, categories) =
        super::today::rules(state).map_err(|error| error.remediation)?;
    let policy = ScanPolicy::for_roots(exclusions, roots);
    let configured = FileTypeFilter::new(categories);
    let documents = FileTypeFilter::new(vec![crate::scan::file_filter::FileCategory::Documents]);
    let repository = state.database.files();
    let mut candidates = Vec::new();
    for id in ids {
        let Some(file) = repository
            .get_by_id(id)
            .map_err(|_| "无法读取待评估文件。".to_owned())?
        else {
            continue;
        };
        let path = Path::new(&file.canonical_path);
        if configured.allows(path) && documents.allows(path) && policy.is_allowed(path) {
            candidates.push(id);
        }
    }
    Ok(candidates)
}

fn evaluate_workspace(
    state: &AppState,
    query_id: &str,
) -> Result<WorkspaceEvaluationOutput, String> {
    let candidate_ids = workspace_evaluation_candidate_ids(state, query_id)?;
    let mut all_outputs = Vec::new();
    for batch in candidate_ids.chunks(200) {
        all_outputs.extend(evaluate(state, batch.to_vec())?);
    }
    let all_ids = state.workspace_queries.all_visible_file_ids(query_id)?;
    let files = all_ids
        .iter()
        .filter_map(|id| state.database.files().get_by_id(*id).ok().flatten())
        .collect::<Vec<_>>();
    let mut value_statuses = state
        .database
        .value_assessments()
        .list_current_for_files(&files)
        .map_err(|_| "无法刷新文件价值评估状态。".to_owned())?
        .into_iter()
        .map(|(id, value)| (id, value.status))
        .collect::<HashMap<_, _>>();
    let document_filter =
        FileTypeFilter::new(vec![crate::scan::file_filter::FileCategory::Documents]);
    for file in &files {
        if !document_filter.allows(Path::new(&file.canonical_path)) {
            value_statuses.insert(file.id, "unsupported".to_owned());
        }
    }
    state
        .workspace_queries
        .set_value_statuses(query_id, value_statuses)?;
    let mut summary = WorkspaceEvaluationOutput {
        evaluated: all_outputs.len(),
        ..WorkspaceEvaluationOutput::default()
    };
    for output in &all_outputs {
        match output.status.as_str() {
            "有价值" => summary.valuable += 1,
            "低价值" => summary.not_valuable += 1,
            "评估失败" => {
                summary.failed += 1;
                if summary.failure_message.is_none() {
                    summary.failure_message = output.message.clone();
                }
            }
            "无法解析" => summary.unsupported += 1,
            _ => {}
        }
    }
    Ok(summary)
}

fn evaluate(state: &AppState, file_ids: Vec<i64>) -> Result<Vec<FileValueOutput>, String> {
    let mut seen = HashSet::new();
    let file_ids = file_ids
        .into_iter()
        .filter(|id| seen.insert(*id))
        .take(200)
        .collect::<Vec<_>>();
    if file_ids.is_empty() {
        return Ok(vec![]);
    }
    let (roots, exclusions, categories) =
        super::today::rules(state).map_err(|error| error.remediation)?;
    let policy = ScanPolicy::for_roots(exclusions, roots);
    let configured_filter = FileTypeFilter::new(categories);
    let document_filter =
        FileTypeFilter::new(vec![crate::scan::file_filter::FileCategory::Documents]);
    let assessments = state.database.value_assessments();
    let value_policy = state
        .database
        .jev_value_policy()
        .get()
        .map_err(|_| "无法读取 JEV 价值评估标准。".to_owned())?;
    let mut outputs = Vec::with_capacity(file_ids.len());
    let mut pending = Vec::<(FileRecord, ValueDocument)>::new();

    for id in file_ids {
        let Some(file) = state
            .database
            .files()
            .get_by_id(id)
            .map_err(|_| "无法读取待评估文件。".to_owned())?
        else {
            continue;
        };
        if !configured_filter.allows(Path::new(&file.canonical_path))
            || !document_filter.allows(Path::new(&file.canonical_path))
            || !policy.is_allowed(Path::new(&file.canonical_path))
        {
            continue;
        }
        if let Some(saved) = assessments
            .find_for_file(
                &file.canonical_path,
                &file.file_identity,
                file.modified_at_utc_ms,
            )
            .map_err(|_| "无法读取已有的价值评估。".to_owned())?
        {
            if is_final_assessment_status(&saved.status) {
                outputs.push(output_from_saved(
                    file.id,
                    &saved.status,
                    saved.score,
                    saved.confidence,
                    saved.message,
                ));
                continue;
            }
        }
        match extract_value_text(Path::new(&file.canonical_path)) {
            Ok(content) => {
                if !claim_value_assessment(&file) {
                    continue;
                }
                pending.push((
                    file.clone(),
                    ValueDocument {
                        key: format!("file_{}", file.id),
                        name: Path::new(&file.canonical_path)
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or(&file.canonical_path)
                            .to_owned(),
                        content,
                    },
                ));
            }
            Err(message) => {
                save_result(
                    state,
                    &file,
                    "unsupported",
                    None,
                    None,
                    Some(message.clone()),
                )?;
                outputs.push(FileValueOutput {
                    file_id: file.id,
                    status: "无法解析".to_owned(),
                    score: None,
                    confidence: None,
                    message: Some(message),
                });
            }
        }
    }

    if pending.is_empty() {
        return Ok(outputs);
    }
    let _pending_claims =
        PendingValueAssessmentClaims(pending.iter().map(|(file, _)| file.clone()).collect());
    state.logger.info(
        "jev",
        &format!("JEV value assessment started for {} files", pending.len()),
    );
    let client =
        match JevClient::from_saved_config(state.database.configs(), WindowsCredentialStore) {
            Ok(client) => client,
            Err(message) => {
                state.logger.error(
                    "jev",
                    &format!("JEV client initialization failed: {message}"),
                );
                for (file, _) in pending {
                    save_result(state, &file, "error", None, None, Some(message.clone()))?;
                    release_value_assessment(&file);
                    outputs.push(FileValueOutput {
                        file_id: file.id,
                        status: "评估失败".to_owned(),
                        score: None,
                        confidence: None,
                        message: Some(message.clone()),
                    });
                }
                return Ok(outputs);
            }
        };

    for batch in pending.chunks(VALUE_BATCH_SIZE) {
        let documents = batch
            .iter()
            .map(|(_, document)| document.clone())
            .collect::<Vec<_>>();
        match client.assess_documents(&documents, &value_policy) {
            Ok(judgments) => {
                for (file, document) in batch {
                    let Some(judgment) = judgments.get(&document.key) else {
                        let message = "JEV 未返回该文件的评分。".to_owned();
                        save_result(state, file, "error", None, None, Some(message.clone()))?;
                        release_value_assessment(file);
                        outputs.push(FileValueOutput {
                            file_id: file.id,
                            status: "评估失败".to_owned(),
                            score: None,
                            confidence: None,
                            message: Some(message),
                        });
                        continue;
                    };
                    let stored_status = if judgment.is_valuable_at(value_policy.valuable_threshold)
                    {
                        "valuable"
                    } else {
                        "not_valuable"
                    };
                    save_result(
                        state,
                        file,
                        stored_status,
                        Some(judgment.score),
                        Some(judgment.confidence),
                        None,
                    )?;
                    release_value_assessment(file);
                    outputs.push(FileValueOutput {
                        file_id: file.id,
                        status: status_label(stored_status).to_owned(),
                        score: Some(judgment.score),
                        confidence: Some(judgment.confidence),
                        message: None,
                    });
                }
            }
            Err(message) => {
                state
                    .logger
                    .error("jev", &format!("JEV value assessment failed: {message}"));
                for (file, _) in batch {
                    save_result(state, file, "error", None, None, Some(message.clone()))?;
                    release_value_assessment(file);
                    outputs.push(FileValueOutput {
                        file_id: file.id,
                        status: "评估失败".to_owned(),
                        score: None,
                        confidence: None,
                        message: Some(message.clone()),
                    });
                }
            }
        }
    }
    state.logger.info(
        "jev",
        &format!(
            "JEV value assessment completed with {} results",
            outputs.len()
        ),
    );
    Ok(outputs)
}

fn save_result(
    state: &AppState,
    file: &FileRecord,
    status: &str,
    score: Option<f64>,
    confidence: Option<f64>,
    message: Option<String>,
) -> Result<(), String> {
    state
        .database
        .value_assessments()
        .save(&FileValueAssessmentInput {
            canonical_path: file.canonical_path.clone(),
            file_identity: file.file_identity.clone(),
            modified_at_utc_ms: file.modified_at_utc_ms,
            status: status.to_owned(),
            score,
            confidence,
            message,
        })
        .map_err(|_| "无法保存价值评估结果。".to_owned())
}

fn output_from_saved(
    file_id: i64,
    status: &str,
    score: Option<f64>,
    confidence: Option<f64>,
    message: Option<String>,
) -> FileValueOutput {
    FileValueOutput {
        file_id,
        status: status_label(status).to_owned(),
        score,
        confidence,
        message,
    }
}

fn status_label(status: &str) -> &str {
    match status {
        "valuable" => "有价值",
        "not_valuable" => "低价值",
        "unsupported" => "无法解析",
        "error" => "评估失败",
        _ => "待分析",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::today::WorkspaceScope;

    #[test]
    fn automatic_workspace_evaluation_is_limited_to_today() {
        assert!(allows_automatic_workspace_evaluation(WorkspaceScope::Today));
        assert!(!allows_automatic_workspace_evaluation(
            WorkspaceScope::Recent
        ));
    }

    #[test]
    fn every_saved_assessment_is_final_for_the_same_file_version() {
        assert!(is_final_assessment_status("valuable"));
        assert!(is_final_assessment_status("not_valuable"));
        assert!(is_final_assessment_status("unsupported"));
        assert!(is_final_assessment_status("error"));
        assert!(!is_final_assessment_status("pending"));
    }

    #[test]
    fn in_flight_assessment_is_claimed_once_until_it_is_released() {
        let file = FileRecord {
            id: 42,
            canonical_path: "D:\\work\\report.docx".to_owned(),
            file_identity: "volume-1:file-42".to_owned(),
            modified_at_utc_ms: 123,
            size_bytes: 10,
            source: "test".to_owned(),
        };
        assert!(claim_value_assessment(&file));
        assert!(!claim_value_assessment(&file));
        release_value_assessment(&file);
        assert!(claim_value_assessment(&file));
        release_value_assessment(&file);
    }
}
