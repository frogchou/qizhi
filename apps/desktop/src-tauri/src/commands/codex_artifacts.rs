use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::{
    app_state::AppState,
    codex::{ArtifactUploadError, ArtifactUploadRequest, CodexArtifactUploadService},
    config::secret_store::WindowsCredentialStore,
    contracts::CodexArtifactUpload,
    ragflow::client::RagflowClient,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCodexArtifactInput {
    pub artifact_id: String,
    pub dataset_id: String,
    pub parent_path: Option<String>,
    pub start_parsing: bool,
    #[serde(default)]
    pub confirm_duplicate: bool,
}

#[tauri::command]
pub async fn upload_codex_artifact(
    input: UploadCodexArtifactInput,
    state: State<'_, AppState>,
) -> Result<CodexArtifactUpload, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let artifact = state
            .database
            .codex()
            .find_artifact(&input.artifact_id)
            .map_err(|_| "无法读取所选生成物。".to_owned())?
            .ok_or_else(|| "所选生成物已经不存在。".to_owned())?;
        let _upload_lease = state
            .codex_runtime
            .reserve_artifact_upload(&artifact.project_id)
            .map_err(|_| user_error(ArtifactUploadError::ActiveTurn))?;
        let client =
            RagflowClient::from_saved_config(state.database.configs(), WindowsCredentialStore)?;
        let service = CodexArtifactUploadService::new(
            state.database.clone(),
            state.codex_runtime.project_files().clone(),
            Arc::new(client),
        );
        let result = service.upload(
            ArtifactUploadRequest {
                artifact_id: input.artifact_id.clone(),
                dataset_id: input.dataset_id,
                parent_path: input.parent_path,
                start_parsing: input.start_parsing,
                confirm_duplicate: input.confirm_duplicate,
            },
            false,
        );
        match result {
            Ok(upload) => {
                state.logger.info(
                    "codex",
                    &format!("artifact upload completed: {} {}", upload.id, upload.status),
                );
                Ok(upload)
            }
            Err(error) => {
                state.logger.error(
                    "codex",
                    &format!("artifact upload failed: {}", input.artifact_id),
                );
                Err(user_error(error))
            }
        }
    })
    .await
    .map_err(|_| "上传生成物时发生意外错误。".to_owned())?
}

#[tauri::command]
pub fn list_codex_artifact_uploads(
    artifact_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CodexArtifactUpload>, String> {
    state
        .database
        .codex()
        .list_artifact_uploads(&artifact_id)
        .map_err(|_| "无法读取生成物上传记录。".to_owned())
}

fn user_error(error: ArtifactUploadError) -> String {
    match error {
        ArtifactUploadError::ActiveTurn => "Codex 正在生成文件，请在任务结束后上传。".to_owned(),
        ArtifactUploadError::SourceChanged => {
            "生成物内容已经变化，请先刷新生成物列表后再上传。".to_owned()
        }
        ArtifactUploadError::DuplicateConfirmationRequired => {
            "该生成物已上传到此知识库，请确认是否再次上传。".to_owned()
        }
        ArtifactUploadError::Uncertain => {
            "上传结果不确定：请求可能已经到达 RAGFlow，请检查知识库后再决定是否重试。".to_owned()
        }
        ArtifactUploadError::InvalidArtifact => "生成物无效或已经不存在。".to_owned(),
        ArtifactUploadError::Failed => "RAGFlow 未能接收该生成物。".to_owned(),
    }
}
