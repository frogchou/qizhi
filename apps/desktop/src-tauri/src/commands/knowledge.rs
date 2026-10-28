use std::{fs::OpenOptions, io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    ragflow::client::{
        RagflowAgent, RagflowAgentAnswer, RagflowAnswer, RagflowChat, RagflowChunk, RagflowClient,
        RagflowDataset,
    },
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
