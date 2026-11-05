use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    ragflow::client::{
        RagflowAgent, RagflowAgentReference, RagflowAgentSource, RagflowAgentStep,
        RagflowAgentStreamEvent, RagflowAnswer, RagflowChat, RagflowChunk, RagflowClient,
        RagflowDataset, RagflowUpload,
    },
    scan::{
        file_filter::FileTypeFilter,
        policy::{ScanPolicy, active_roots},
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRagflowInput {
    chat_id: String,
    question: String,
}

#[derive(Clone, Debug, Serialize)]
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowChunkOutput {
    id: String,
    content: String,
    document_name: String,
    document_id: String,
    dataset_id: String,
    similarity: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentResultOutput {
    pub agent_id: String,
    pub answer: Option<String>,
    pub error: Option<String>,
    pub session_id: Option<String>,
    pub session_invalid: bool,
    pub steps: Vec<RagflowAgentStep>,
    pub references: Vec<RagflowAgentReference>,
    pub sources: Vec<RagflowAgentSource>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowKnowledgeQueryOutput {
    pub selection_token: String,
    pub chunks: Vec<RagflowChunkOutput>,
    pub retrieval_error: Option<String>,
    pub agent_results: Vec<RagflowAgentResultOutput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KnowledgeQueryStreamEvent {
    RetrievalStarted,
    RetrievalCompleted {
        chunks: Vec<RagflowChunkOutput>,
    },
    RetrievalFailed {
        error: String,
    },
    AgentStarted {
        agent_id: String,
    },
    AgentAnswerReset {
        agent_id: String,
        message_id: String,
    },
    AgentDelta {
        agent_id: String,
        delta: String,
    },
    AgentThinking {
        agent_id: String,
        active: bool,
    },
    AgentStep {
        agent_id: String,
        step: RagflowAgentStep,
    },
    AgentReferences {
        agent_id: String,
        references: Vec<RagflowAgentReference>,
        sources: Vec<RagflowAgentSource>,
    },
    AgentCompleted {
        agent_id: String,
        session_id: Option<String>,
    },
    AgentFailed {
        agent_id: String,
        error: String,
        session_invalid: bool,
    },
    Completed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRagflowKnowledgeInput {
    question: String,
    dataset_ids: Vec<String>,
    agent_ids: Vec<String>,
    #[serde(default)]
    agent_sessions: HashMap<String, String>,
}

pub fn unique_agent_ids(agent_ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    agent_ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect()
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
    document_ids: Vec<String>,
    document_count: usize,
    parsing_started: bool,
    parsing_error: Option<String>,
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

fn upload_policy(state: &AppState) -> Result<(ScanPolicy, FileTypeFilter), String> {
    let rules = state
        .scan_rules
        .get()
        .map_err(|_| "无法读取扫描规则。".to_owned())?;
    let exclusions = rules
        .custom_exclusions
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let roots = active_roots(&rules.allowed_roots, &exclusions)
        .map_err(|_| "扫描目录无效，请在设置中重新保存。".to_owned())?;
    if rules.allowed_roots.is_empty() {
        return Err("请先在设置中添加允许扫描的工作目录。".to_owned());
    }
    Ok((
        ScanPolicy::for_roots(exclusions, roots),
        FileTypeFilter::new(rules.file_categories),
    ))
}

fn ensure_upload_candidate(
    file: &crate::contracts::FileRecord,
    policy: &ScanPolicy,
    file_filter: &FileTypeFilter,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(&file.canonical_path);
    if !policy.is_allowed(&path) {
        return Err("该文件已不在允许扫描范围内，无法上传。".to_owned());
    }
    let (start, end) = crate::commands::today::current_day_bounds();
    if file.modified_at_utc_ms < start
        || file.modified_at_utc_ms >= end
        || !crate::commands::today::is_visible_today_file(file, file_filter, policy)
    {
        return Err("所选文件已不在当前今日列表中，无法上传。".to_owned());
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
    on_event: Channel<KnowledgeQueryStreamEvent>,
) -> Result<RagflowKnowledgeQueryOutput, String> {
    if input.question.trim().is_empty()
        || (input.dataset_ids.is_empty() && input.agent_ids.is_empty())
    {
        return Err("请输入关键词，并至少选择一个知识库或 Agent。".to_owned());
    }
    let agent_ids = unique_agent_ids(input.agent_ids);
    if input.dataset_ids.is_empty() && agent_ids.is_empty() {
        return Err("请输入关键词，并至少选择一个知识库或 Agent。".to_owned());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let client = client(&state)?;
            let retrieval_handle = if input.dataset_ids.is_empty() {
                None
            } else {
                let client = client.clone();
                let question = input.question.clone();
                let dataset_ids = input.dataset_ids.clone();
                let events = on_event.clone();
                let _ = events.send(KnowledgeQueryStreamEvent::RetrievalStarted);
                Some(std::thread::spawn(move || {
                    match client.retrieve(&question, dataset_ids) {
                        Ok(items) => {
                            let chunks = items.into_iter().map(Into::into).collect::<Vec<_>>();
                            let _ = events.send(KnowledgeQueryStreamEvent::RetrievalCompleted {
                                chunks: chunks.clone(),
                            });
                            Ok(chunks)
                        }
                        Err(error) => {
                            let _ = events.send(KnowledgeQueryStreamEvent::RetrievalFailed {
                                error: error.clone(),
                            });
                            Err(error)
                        }
                    }
                }))
            };
            let handles = agent_ids
                .into_iter()
                .map(|agent_id| {
                    let client = client.clone();
                    let question = input.question.clone();
                    let session_id = input.agent_sessions.get(&agent_id).cloned();
                    let events = on_event.clone();
                    let worker_agent_id = agent_id.clone();
                    let handle = std::thread::spawn(move || {
                        let _ = events.send(KnowledgeQueryStreamEvent::AgentStarted {
                            agent_id: worker_agent_id.clone(),
                        });
                        let mut streamed_answer = String::new();
                        let mut steps = Vec::new();
                        let mut references = Vec::new();
                        let mut sources = Vec::new();
                        let answer = client.ask_agent_streaming(
                            &worker_agent_id,
                            &question,
                            session_id.as_deref(),
                            |event| {
                                match event {
                                    RagflowAgentStreamEvent::AnswerReset { message_id } => {
                                        streamed_answer.clear();
                                        let _ = events.send(
                                            KnowledgeQueryStreamEvent::AgentAnswerReset {
                                                agent_id: worker_agent_id.clone(),
                                                message_id,
                                            },
                                        );
                                    }
                                    RagflowAgentStreamEvent::Delta { delta } => {
                                        streamed_answer.push_str(&delta);
                                        let _ =
                                            events.send(KnowledgeQueryStreamEvent::AgentDelta {
                                                agent_id: worker_agent_id.clone(),
                                                delta,
                                            });
                                    }
                                    RagflowAgentStreamEvent::Thinking { active } => {
                                        let _ =
                                            events.send(KnowledgeQueryStreamEvent::AgentThinking {
                                                agent_id: worker_agent_id.clone(),
                                                active,
                                            });
                                    }
                                    RagflowAgentStreamEvent::Step(step) => {
                                        steps.push(step.clone());
                                        let _ = events.send(KnowledgeQueryStreamEvent::AgentStep {
                                            agent_id: worker_agent_id.clone(),
                                            step,
                                        });
                                    }
                                    RagflowAgentStreamEvent::References {
                                        references: next_references,
                                        sources: next_sources,
                                    } => {
                                        references = next_references.clone();
                                        sources = next_sources.clone();
                                        let _ = events.send(
                                            KnowledgeQueryStreamEvent::AgentReferences {
                                                agent_id: worker_agent_id.clone(),
                                                references: next_references,
                                                sources: next_sources,
                                            },
                                        );
                                    }
                                }
                                Ok(())
                            },
                        );
                        match answer {
                            Ok(answer) => {
                                let session_id =
                                    (!answer.session_id.is_empty()).then_some(answer.session_id);
                                let _ = events.send(KnowledgeQueryStreamEvent::AgentCompleted {
                                    agent_id: worker_agent_id.clone(),
                                    session_id: session_id.clone(),
                                });
                                RagflowAgentResultOutput {
                                    agent_id: worker_agent_id,
                                    answer: Some(answer.answer),
                                    error: None,
                                    session_id,
                                    session_invalid: false,
                                    steps,
                                    references: answer.references,
                                    sources: answer.sources,
                                }
                            }
                            Err(error) => {
                                let session_invalid = is_invalid_agent_session(&error);
                                let _ = events.send(KnowledgeQueryStreamEvent::AgentFailed {
                                    agent_id: worker_agent_id.clone(),
                                    error: error.clone(),
                                    session_invalid,
                                });
                                RagflowAgentResultOutput {
                                    agent_id: worker_agent_id,
                                    answer: (!streamed_answer.is_empty())
                                        .then_some(streamed_answer),
                                    error: Some(error),
                                    session_id,
                                    session_invalid,
                                    steps,
                                    references,
                                    sources,
                                }
                            }
                        }
                    });
                    (agent_id, handle)
                })
                .collect::<Vec<_>>();
            let mut agent_results = Vec::new();
            for (agent_id, handle) in handles {
                match handle.join() {
                    Ok(output) => agent_results.push(output),
                    Err(_) => {
                        let error = "Agent 工作线程意外终止。".to_owned();
                        let _ = on_event.send(KnowledgeQueryStreamEvent::AgentFailed {
                            agent_id: agent_id.clone(),
                            error: error.clone(),
                            session_invalid: false,
                        });
                        agent_results.push(RagflowAgentResultOutput {
                            agent_id,
                            answer: None,
                            error: Some(error),
                            session_id: None,
                            session_invalid: false,
                            steps: vec![],
                            references: vec![],
                            sources: vec![],
                        });
                    }
                }
            }
            let (chunks, retrieval_error) = match retrieval_handle {
                None => (vec![], None),
                Some(handle) => match handle.join() {
                    Ok(Ok(chunks)) => (chunks, None),
                    Ok(Err(error)) => (vec![], Some(error)),
                    Err(_) => (vec![], Some("知识库检索线程意外终止。".to_owned())),
                },
            };
            let _ = on_event.send(KnowledgeQueryStreamEvent::Completed);
            let selection_token = state.knowledge_selections.register(
                chunks
                    .iter()
                    .map(|chunk| (chunk.dataset_id.clone(), chunk.document_id.clone()))
                    .chain(agent_results.iter().flat_map(|result| {
                        result
                            .sources
                            .iter()
                            .map(|source| (source.dataset_id.clone(), source.document_id.clone()))
                            .collect::<Vec<_>>()
                    })),
            );
            Ok(RagflowKnowledgeQueryOutput {
                selection_token,
                chunks,
                retrieval_error,
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

fn is_invalid_agent_session(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("session")
        && (normalized.contains("not found")
            || normalized.contains("invalid")
            || normalized.contains("expired"))
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
            let (policy, file_filter) = upload_policy(&state)?;
            let file_path = ensure_upload_candidate(&file, &policy, &file_filter)?;
            let RagflowUpload {
                document_ids,
                document_count,
                parsing_started,
                parsing_error,
                ..
            } = client(&state)?.upload_document(
                &file_path,
                input.dataset_id.trim(),
                input.parent_path.as_deref(),
                input.start_parsing,
            )?;
            Ok(RagflowUploadOutput {
                document_ids,
                document_count,
                parsing_started,
                parsing_error,
            })
        })();
        match &result {
            Ok(output) => {
                state.logger.info(
                    "ragflow",
                    &format!(
                        "today file uploaded: {} document(s), parsing_started={}",
                        output.document_count, output.parsing_started
                    ),
                );
                if let Some(error) = &output.parsing_error {
                    state.logger.error(
                        "ragflow",
                        &format!("today file uploaded but parsing did not start: {error}"),
                    );
                }
            }
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
        scan::{
            file_filter::FileTypeFilter,
            policy::{AllowedRoot, ScanPolicy},
        },
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

        let error = ensure_upload_candidate(&file, &policy, &FileTypeFilter::default())
            .expect_err("a file outside the approved scan scope cannot be uploaded");

        assert_eq!(error, "该文件已不在允许扫描范围内，无法上传。".to_owned());
    }

    #[test]
    fn refuses_to_upload_a_record_that_is_no_longer_visible_in_today() {
        let root = std::env::current_dir().expect("current directory");
        let path = root.join("Cargo.toml");
        let file = FileRecord {
            id: 1,
            canonical_path: path.to_string_lossy().to_string(),
            file_identity: "legacy-record".to_owned(),
            modified_at_utc_ms: chrono::Local::now().timestamp_millis(),
            size_bytes: 1,
            source: "本机文件".to_owned(),
        };
        let allowed_root = ScanPolicy::new(vec![])
            .validate_root(&root)
            .expect("current directory is a valid root");
        let policy = ScanPolicy::for_roots(vec![], vec![allowed_root]);

        let error = ensure_upload_candidate(&file, &policy, &FileTypeFilter::default())
            .expect_err("retired scanner records are not current Today candidates");

        assert_eq!(error, "所选文件已不在当前今日列表中，无法上传。");
    }
}
