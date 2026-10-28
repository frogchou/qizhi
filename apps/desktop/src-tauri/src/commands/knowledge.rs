use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    config::secret_store::WindowsCredentialStore,
    ragflow::client::{RagflowAnswer, RagflowChat, RagflowClient},
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
