use serde::Deserialize;
use tauri::State;

use crate::{
    app_state::AppState,
    codex::CodexHandoffServiceError,
    config::secret_store::WindowsCredentialStore,
    contracts::{
        CodexHandoffDetails, CodexHandoffPreview, CodexHandoffResult, CodexRagflowAnswerInput,
        CodexRagflowChunkInput, CodexRagflowDocumentInput, CommitCodexHandoffInput,
    },
    ragflow::client::RagflowClient,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareCodexHandoffInput {
    pub source: PrepareCodexHandoffSource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PrepareCodexHandoffSource {
    Today {
        query_id: String,
        #[serde(default)]
        file_ids: Vec<i64>,
        #[serde(default)]
        directory_ids: Vec<String>,
    },
    Recent {
        query_id: String,
        #[serde(default)]
        file_ids: Vec<i64>,
        #[serde(default)]
        directory_ids: Vec<String>,
    },
    RagflowChunks {
        question: String,
        chunks: Vec<CodexRagflowChunkInput>,
    },
    RagflowDocuments {
        selection_token: String,
        documents: Vec<CodexRagflowDocumentInput>,
    },
    RagflowAnswer {
        answer: CodexRagflowAnswerInput,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCodexHandoffCommandInput {
    pub source_kind: String,
    pub preparation_id: String,
    pub request_id: String,
    pub project_id: String,
    pub conversation_id: String,
    #[serde(default)]
    pub confirm_large_files: bool,
    #[serde(default)]
    pub confirm_original_only: bool,
}

impl CommitCodexHandoffCommandInput {
    fn service_input(&self) -> CommitCodexHandoffInput {
        CommitCodexHandoffInput {
            preparation_id: self.preparation_id.clone(),
            request_id: self.request_id.clone(),
            project_id: self.project_id.clone(),
            conversation_id: self.conversation_id.clone(),
            confirm_large_files: self.confirm_large_files,
            confirm_original_only: self.confirm_original_only,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissCodexHandoffItemInput {
    pub handoff_id: String,
    pub material_id: String,
}

pub fn prepare_handoff(
    state: &AppState,
    input: PrepareCodexHandoffInput,
) -> Result<CodexHandoffPreview, String> {
    let result = match input.source {
        PrepareCodexHandoffSource::Today {
            query_id,
            file_ids,
            directory_ids,
        } => state
            .codex_handoffs
            .prepare_today(&query_id, &file_ids, &directory_ids),
        PrepareCodexHandoffSource::Recent {
            query_id,
            file_ids,
            directory_ids,
        } => state
            .codex_handoffs
            .prepare_recent(&query_id, &file_ids, &directory_ids),
        PrepareCodexHandoffSource::RagflowChunks { question, chunks } => state
            .codex_handoffs
            .prepare_ragflow_chunks(&question, chunks),
        PrepareCodexHandoffSource::RagflowDocuments {
            selection_token,
            documents,
        } => {
            if !state.knowledge_selections.allows_documents(
                selection_token.trim(),
                documents
                    .iter()
                    .map(|document| (document.dataset_id.as_str(), document.document_id.as_str())),
            ) {
                return Err("所选 RAGFlow 文档已失效，请重新查询后再发送。".to_owned());
            }
            state.codex_handoffs.prepare_ragflow_documents(documents)
        }
        PrepareCodexHandoffSource::RagflowAnswer { answer } => {
            state.codex_handoffs.prepare_ragflow_answer(answer)
        }
    };
    result.map_err(user_handoff_error)
}

pub fn commit_handoff(
    state: &AppState,
    input: CommitCodexHandoffCommandInput,
) -> Result<CodexHandoffResult, String> {
    if input.request_id.trim().is_empty()
        || input.project_id.trim().is_empty()
        || input.conversation_id.trim().is_empty()
    {
        return Err("请选择有效的 Codex 项目和会话。".to_owned());
    }
    let _mutation_lease = state
        .codex_runtime
        .reserve_project_mutation(&input.project_id)
        .map_err(|_| "该 Codex 项目正在执行任务，请在当前任务结束后再发送资料。".to_owned())?;
    if input.source_kind.starts_with("ragflow_") {
        let client =
            RagflowClient::from_saved_config(state.database.configs(), WindowsCredentialStore)
                .map_err(|_| "无法读取 RAGFlow 连接设置，请在设置中检查后重试。".to_owned())?;
        state
            .codex_handoffs
            .commit_ragflow(input.service_input(), &client)
            .map_err(user_handoff_error)
    } else if matches!(input.source_kind.as_str(), "today" | "recent") {
        state
            .codex_handoffs
            .commit_local(input.service_input())
            .map_err(user_handoff_error)
    } else {
        Err("资料来源无效，请重新发起发送。".to_owned())
    }
}

pub fn list_pending_handoffs(
    state: &AppState,
    conversation_id: &str,
) -> Result<Vec<CodexHandoffDetails>, String> {
    if conversation_id.trim().is_empty() {
        return Err("请选择有效的 Codex 会话。".to_owned());
    }
    state
        .database
        .codex()
        .list_pending_handoffs(conversation_id)
        .map_err(|_| "无法读取待处理资料。".to_owned())
}

pub fn dismiss_handoff_item(
    state: &AppState,
    input: &DismissCodexHandoffItemInput,
) -> Result<(), String> {
    state
        .database
        .codex()
        .dismiss_handoff_item(&input.handoff_id, &input.material_id)
        .map_err(|_| "无法移除这项待处理资料。".to_owned())
}

#[tauri::command]
pub fn prepare_codex_handoff(
    input: PrepareCodexHandoffInput,
    state: State<'_, AppState>,
) -> Result<CodexHandoffPreview, String> {
    prepare_handoff(&state, input)
}

#[tauri::command]
pub fn commit_codex_handoff(
    input: CommitCodexHandoffCommandInput,
    state: State<'_, AppState>,
) -> Result<CodexHandoffResult, String> {
    commit_handoff(&state, input)
}

#[tauri::command]
pub fn list_pending_codex_handoffs(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexHandoffDetails>, String> {
    list_pending_handoffs(&state, &conversation_id)
}

#[tauri::command]
pub fn dismiss_codex_handoff_item(
    input: DismissCodexHandoffItemInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    dismiss_handoff_item(&state, &input)
}

fn user_handoff_error(error: CodexHandoffServiceError) -> String {
    error.to_string()
}
