use std::{fs::OpenOptions, io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    ragflow::client::{
        RagflowAgent, RagflowAgentAnswer, RagflowAnswer, RagflowChat, RagflowChunk, RagflowClient,
        RagflowDataset, RagflowUpload,
    },
    scan::policy::ScanPolicy,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRagflowInput {
    chat_id: String,
    question: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowChatOutput {
    id: String,
    name: String,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAnswerOutput {
    answer: String,
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowDatasetOutput {
    id: String,
    name: String,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentOutput {
    id: String,
    name: String,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowChunkOutput {
    id: String,
    content: String,
    document_name: String,
    document_id: String,
    dataset_id: String,
    similarity: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentResultOutput {
    agent_id: String,
    answer: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowKnowledgeQueryOutput {
    chunks: Vec<RagflowChunkOutput>,
    agent_results: Vec<RagflowAgentResultOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRagflowKnowledgeInput {
    question: String,
    dataset_ids: Vec<String>,
    agent_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRagflowDocumentInput {
    dataset_id: String,
    document_id: String,
    save_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRagflowDocumentOutput {
    saved_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadTodayFileInput {
    file_id: i64,
    dataset_id: String,
    parent_path: Option<String>,
    start_parsing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowUploadOutput {
    document_count: usize,
    parsing_started: bool,
}

impl From<RagflowChat> for RagflowChatOutput {
    fn from(value: RagflowChat) -> Self {
        Self {
            id: value.id,
            name: value.name,
            description: value.description,
        }
    }
}

impl From<RagflowAnswer> for RagflowAnswerOutput {
    fn from(value: RagflowAnswer) -> Self {
        Self {
            answer: value.answer,
            session_id: value.session_id,
        }
    }
}

impl From<RagflowDataset> for RagflowDatasetOutput {
    fn from(value: RagflowDataset) -> Self {
        Self {
            id: value.id,
            name: value.name,
            description: value.description,
        }
    }
}
impl From<RagflowAgent> for RagflowAgentOutput {
    fn from(value: RagflowAgent) -> Self {
        Self {
            id: value.id,
            name: value.name,
            description: value.description,
        }
    }
}
impl From<RagflowChunk> for RagflowChunkOutput {
    fn from(value: RagflowChunk) -> Self {
        Self {
            id: value.id,
            content: value.content,
            document_name: value.document_name,
            document_id: value.document_id,
            dataset_id: value.dataset_id,
            similarity: value.similarity,
        }
    }
}

fn client(state: &AppState) -> Result<RagflowClient, String> {
    RagflowClient::from_saved_config(state.database.configs(), WindowsCredentialStore)
}

fn upload_policy(state: &AppState) -> Result<ScanPolicy, String> {
    let rules = state
        .scan_rules
        .get()
        .map_err(|_| "无法读取扫描规则。".to_owned())?;
    let exclusions = rules
        .custom_exclusions
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let validation_policy = ScanPolicy::new(exclusions.clone());
    let roots = rules
        .allowed_roots
        .iter()
        .map(PathBuf::from)
        .map(|root| validation_policy.validate_root(&root))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "扫描目录无效，请在设置中重新保存。".to_owned())?;
    if roots.is_empty() {
        return Err("请先在设置中添加允许扫描的工作目录。".to_owned());
    }
    Ok(ScanPolicy::for_roots(exclusions, roots))
}

fn ensure_upload_candidate(
    file: &crate::contracts::FileRecord,
    policy: &ScanPolicy,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(&file.canonical_path);
    if !policy.is_allowed(&path) {
        return Err("该文件已不在允许扫描范围内，无法上传。".to_owned());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|_| "无法读取要上传的文件，它可能已移动或没有访问权限。".to_owned())?;
    if !metadata.is_file() {
        return Err("所选内容不是可上传的文件。".to_owned());
    }
    Ok(path)
}

#[tauri::command]
pub async fn list_ragflow_chats(
    state: State<'_, AppState>,
) -> Result<Vec<RagflowChatOutput>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client(&state).and_then(|client| {
            client.list_chats().map(|chats| {
                chats
                    .into_iter()
                    .map(RagflowChatOutput::from)
                    .collect::<Vec<_>>()
            })
        });
        match &result {
            Ok(chats) => state.logger.info(
                "ragflow",
                &format!("loaded {} RAGFlow chat assistants", chats.len()),
            ),
            Err(error) => state.logger.error(
                "ragflow",
                &format!("loading chat assistants failed: {error}"),
            ),
        }
        result
    })
    .await
    .map_err(|_| "读取 RAGFlow 问答机器人时发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn ask_ragflow_chat(
    state: State<'_, AppState>,
    input: AskRagflowInput,
) -> Result<RagflowAnswerOutput, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client(&state)
            .and_then(|client| client.ask(&input.chat_id, &input.question))
            .map(RagflowAnswerOutput::from);
        match &result {
            Ok(_) => state.logger.info("ragflow", "RAGFlow question completed"),
            Err(error) => state
                .logger
                .error("ragflow", &format!("RAGFlow question failed: {error}")),
        }
        result
    })
    .await
    .map_err(|_| "RAGFlow 问答时发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn list_ragflow_datasets(
    state: State<'_, AppState>,
) -> Result<Vec<RagflowDatasetOutput>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client(&state).and_then(|client| {
            client
                .list_datasets()
                .map(|items| items.into_iter().map(Into::into).collect::<Vec<_>>())
        });
        match &result {
            Ok(items) => state.logger.info(
                "ragflow",
                &format!("loaded {} RAGFlow datasets", items.len()),
            ),
            Err(error) => state.logger.error(
                "ragflow",
                &format!("loading RAGFlow datasets failed: {error}"),
            ),
        }
        result
    })
    .await
    .map_err(|_| "读取 RAGFlow 知识库时发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn list_ragflow_agents(
    state: State<'_, AppState>,
) -> Result<Vec<RagflowAgentOutput>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = client(&state).and_then(|client| {
            client
                .list_agents()
                .map(|items| items.into_iter().map(Into::into).collect::<Vec<_>>())
        });
        match &result {
            Ok(items) => state
                .logger
                .info("ragflow", &format!("loaded {} RAGFlow agents", items.len())),
            Err(error) => state.logger.error(
                "ragflow",
                &format!("loading RAGFlow agents failed: {error}"),
            ),
        }
        result
    })
    .await
    .map_err(|_| "读取 RAGFlow Agents 时发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn query_ragflow_knowledge(
    state: State<'_, AppState>,
    input: QueryRagflowKnowledgeInput,
) -> Result<RagflowKnowledgeQueryOutput, String> {
    if input.question.trim().is_empty()
        || (input.dataset_ids.is_empty() && input.agent_ids.is_empty())
    {
        return Err("请输入关键词，并至少选择一个知识库或 Agent。".to_owned());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let client = client(&state)?;
            let chunks = if input.dataset_ids.is_empty() {
                Ok(vec![])
            } else {
                client
                    .retrieve(&input.question, input.dataset_ids)
                    .map(|items| items.into_iter().map(Into::into).collect())
            }?;
            let handles = input.agent_ids.into_iter().map(|agent_id| {
                let client = client.clone();
                let question = input.question.clone();
                std::thread::spawn(move || match client.ask_agent(&agent_id, &question) {
                    Ok(RagflowAgentAnswer { answer, .. }) => RagflowAgentResultOutput {
                        agent_id,
                        answer: Some(answer),
                        error: None,
                    },
                    Err(error) => RagflowAgentResultOutput {
                        agent_id,
                        answer: None,
                        error: Some(error),
                    },
                })
            });
            let agent_results = handles.filter_map(|handle| handle.join().ok()).collect();
            Ok(RagflowKnowledgeQueryOutput {
                chunks,
                agent_results,
            })
        })();
        match &result {
            Ok(output) => {
                let failed_agents = output
                    .agent_results
                    .iter()
                    .filter(|item| item.error.is_some())
                    .count();
                for agent_result in output
                    .agent_results
                    .iter()
                    .filter(|item| item.error.is_some())
                {
                    state.logger.error(
                        "ragflow",
                        &format!(
                            "RAGFlow Agent {} failed: {}",
                            agent_result.agent_id,
                            agent_result.error.as_deref().unwrap_or_default()
                        ),
                    );
                }
                state.logger.info(
                    "ragflow",
                    &format!(
                        "RAGFlow knowledge query completed: {} chunks, {} agent failures",
                        output.chunks.len(),
                        failed_agents
                    ),
                );
            }
            Err(error) => state.logger.error(
                "ragflow",
                &format!("RAGFlow knowledge query failed: {error}"),
            ),
        }
        result
    })
    .await
    .map_err(|_| "查询 RAGFlow 知识库时发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn download_ragflow_document(
    state: State<'_, AppState>,
    input: DownloadRagflowDocumentInput,
) -> Result<DownloadRagflowDocumentOutput, String> {
    let destination = PathBuf::from(input.save_path.trim());
    if destination.file_name().is_none()
        || destination.parent().is_none_or(|parent| !parent.exists())
    {
        return Err("请选择有效的保存位置。".to_owned());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let bytes = client(&state)?.download_document(&input.dataset_id, &input.document_id)?;
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        "目标文件已存在，请重新选择保存位置。".to_owned()
                    } else {
                        "无法创建下载文件，请检查保存位置。".to_owned()
                    }
                })?;
            target
                .write_all(&bytes)
                .map_err(|_| "下载的文件无法写入磁盘。".to_owned())?;
            Ok(DownloadRagflowDocumentOutput {
                saved_path: destination.display().to_string(),
            })
        })();
        match &result {
            Ok(_) => state.logger.info("ragflow", "RAGFlow document downloaded"),
            Err(error) => state.logger.error(
                "ragflow",
                &format!("RAGFlow document download failed: {error}"),
            ),
        }
        result
    })
    .await
    .map_err(|_| "下载 RAGFlow 文件时发生意外错误。".to_owned())?
}

#[tauri::command]
pub async fn upload_today_file(
    state: State<'_, AppState>,
    input: UploadTodayFileInput,
) -> Result<RagflowUploadOutput, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            if input.dataset_id.trim().is_empty() {
                return Err("请选择目标知识库。".to_owned());
            }
            let file = state
                .database
                .files()
                .get_by_id(input.file_id)
                .map_err(|_| "无法读取所选文件。".to_owned())?
                .ok_or_else(|| "所选文件已不在今日列表中。".to_owned())?;
            let file_path = ensure_upload_candidate(&file, &upload_policy(&state)?)?;
            let RagflowUpload {
                document_count,
                parsing_started,
                ..
            } = client(&state)?.upload_document(
                &file_path,
                input.dataset_id.trim(),
                input.parent_path.as_deref(),
                input.start_parsing,
            )?;
            Ok(RagflowUploadOutput {
                document_count,
                parsing_started,
            })
        })();
        match &result {
            Ok(output) => state.logger.info(
                "ragflow",
                &format!(
                    "today file uploaded: {} document(s), parsing_started={}",
                    output.document_count, output.parsing_started
                ),
            ),
            Err(error) => state
                .logger
                .error("ragflow", &format!("today file upload failed: {error}")),
        }
        result
    })
    .await
    .map_err(|_| "上传知识库时发生意外错误。".to_owned())?
}

#[cfg(test)]
mod tests {
    use crate::{
        contracts::FileRecord,
        scan::policy::{AllowedRoot, ScanPolicy},
    };

    use super::ensure_upload_candidate;

    #[test]
    fn refuses_to_upload_a_file_outside_the_current_scan_policy() {
        let file = FileRecord {
            id: 1,
            canonical_path: r"C:\Windows\System32\private.docx".to_owned(),
            file_identity: "outside-scope".to_owned(),
            modified_at_utc_ms: 1,
            size_bytes: 1,
            source: "本机 NTFS 索引".to_owned(),
        };
        let policy = ScanPolicy::for_roots(
            vec![],
            vec![AllowedRoot(
                std::env::current_dir().expect("current directory"),
            )],
        );

        let error = ensure_upload_candidate(&file, &policy)
            .expect_err("a file outside the approved scan scope cannot be uploaded");

        assert_eq!(error, "该文件已不在允许扫描范围内，无法上传。".to_owned());
    }
}
