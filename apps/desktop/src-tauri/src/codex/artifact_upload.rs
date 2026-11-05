use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    contracts::{CodexArtifactUpload, CodexArtifactUploadInput},
    database::Database,
    ragflow::client::{RagflowClient, RagflowUpload, RagflowUploadFailure},
};

use super::CodexProjectFiles;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactUploadRequest {
    pub artifact_id: String,
    pub dataset_id: String,
    pub parent_path: Option<String>,
    pub start_parsing: bool,
    pub confirm_duplicate: bool,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ArtifactUploadError {
    #[error("artifact is invalid")]
    InvalidArtifact,
    #[error("project has an active turn")]
    ActiveTurn,
    #[error("artifact bytes changed")]
    SourceChanged,
    #[error("duplicate confirmation required")]
    DuplicateConfirmationRequired,
    #[error("upload failed")]
    Failed,
    #[error("upload delivery is uncertain")]
    Uncertain,
}

pub trait ArtifactUploader: Send + Sync {
    fn upload_document(
        &self,
        file_path: &Path,
        dataset_id: &str,
        parent_path: Option<&str>,
        start_parsing: bool,
    ) -> Result<RagflowUpload, ArtifactUploadError>;
}

impl ArtifactUploader for RagflowClient {
    fn upload_document(
        &self,
        file_path: &Path,
        dataset_id: &str,
        parent_path: Option<&str>,
        start_parsing: bool,
    ) -> Result<RagflowUpload, ArtifactUploadError> {
        self.upload_document_with_outcome(file_path, dataset_id, parent_path, start_parsing)
            .map_err(|error| match error {
                RagflowUploadFailure::BeforeRequest(_) | RagflowUploadFailure::Rejected(_) => {
                    ArtifactUploadError::Failed
                }
                RagflowUploadFailure::Uncertain(_) => ArtifactUploadError::Uncertain,
            })
    }
}

#[derive(Clone)]
pub struct CodexArtifactUploadService {
    database: Database,
    files: CodexProjectFiles,
    uploader: Arc<dyn ArtifactUploader>,
}

struct UploadSnapshot {
    path: PathBuf,
    directory: PathBuf,
}

impl Drop for UploadSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

impl CodexArtifactUploadService {
    pub fn new(
        database: Database,
        files: CodexProjectFiles,
        uploader: Arc<dyn ArtifactUploader>,
    ) -> Self {
        Self {
            database,
            files,
            uploader,
        }
    }

    pub fn upload(
        &self,
        input: ArtifactUploadRequest,
        project_has_active_turn: bool,
    ) -> Result<CodexArtifactUpload, ArtifactUploadError> {
        if project_has_active_turn || input.dataset_id.trim().is_empty() {
            return Err(if project_has_active_turn {
                ArtifactUploadError::ActiveTurn
            } else {
                ArtifactUploadError::InvalidArtifact
            });
        }
        let artifact = self
            .database
            .codex()
            .find_artifact(&input.artifact_id)
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?
            .ok_or(ArtifactUploadError::InvalidArtifact)?;
        if artifact.state != "active" {
            return Err(ArtifactUploadError::InvalidArtifact);
        }
        let path = self.safe_artifact_path(&artifact.project_id, &artifact.relative_path)?;
        let actual_hash = sha256_file(&path)?;
        if actual_hash != artifact.content_hash {
            return Err(ArtifactUploadError::SourceChanged);
        }
        let snapshot = self.snapshot_for_upload(&artifact.project_id, &path, &actual_hash)?;
        let previous = self
            .database
            .codex()
            .list_artifact_uploads(&artifact.id)
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        let duplicate = previous.iter().any(|upload| {
            upload.dataset_id == input.dataset_id.trim()
                && upload.content_hash == actual_hash
                && matches!(upload.status.as_str(), "uploaded" | "uploaded_parse_failed")
        });
        if duplicate && !input.confirm_duplicate {
            return Err(ArtifactUploadError::DuplicateConfirmationRequired);
        }
        let now = now_ms();
        let attempt = self.record(
            &artifact.id,
            &input,
            &actual_hash,
            "uploading",
            None,
            None,
            now,
            None,
        )?;
        match self.uploader.upload_document(
            &snapshot.path,
            input.dataset_id.trim(),
            input.parent_path.as_deref(),
            input.start_parsing,
        ) {
            Ok(upload) => {
                let status = if upload.parsing_error.is_some() {
                    "uploaded_parse_failed"
                } else {
                    "uploaded"
                };
                self.finish(
                    &attempt.id,
                    status,
                    Some(
                        serde_json::to_string(&upload.document_ids)
                            .map_err(|_| ArtifactUploadError::Failed)?,
                    ),
                    upload.parsing_error,
                )
            }
            Err(error @ ArtifactUploadError::Uncertain)
            | Err(error @ ArtifactUploadError::Failed) => {
                let status = if error == ArtifactUploadError::Uncertain {
                    "uncertain"
                } else {
                    "failed"
                };
                let completed = self.finish(
                    &attempt.id,
                    status,
                    None,
                    Some(if status == "uncertain" {
                        "上传请求可能已经到达 RAGFlow，请先检查知识库再决定是否重试。".to_owned()
                    } else {
                        "RAGFlow 明确拒绝了上传请求。".to_owned()
                    }),
                );
                if completed.is_err() {
                    Err(ArtifactUploadError::Uncertain)
                } else {
                    Err(error)
                }
            }
            Err(error) => {
                if self
                    .finish(
                        &attempt.id,
                        "failed",
                        None,
                        Some("上传未发送到 RAGFlow。".to_owned()),
                    )
                    .is_err()
                {
                    Err(ArtifactUploadError::Uncertain)
                } else {
                    Err(error)
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record(
        &self,
        artifact_id: &str,
        input: &ArtifactUploadRequest,
        hash: &str,
        status: &str,
        document_ids_json: Option<String>,
        error_summary: Option<String>,
        now: i64,
        completed_at_utc_ms: Option<i64>,
    ) -> Result<CodexArtifactUpload, ArtifactUploadError> {
        self.database
            .codex()
            .record_artifact_upload(&CodexArtifactUploadInput {
                artifact_id: artifact_id.to_owned(),
                dataset_id: input.dataset_id.trim().to_owned(),
                parent_path: input.parent_path.clone(),
                content_hash: hash.to_owned(),
                document_ids_json,
                status: status.to_owned(),
                start_parsing: input.start_parsing,
                created_at_utc_ms: now,
                completed_at_utc_ms,
                error_summary,
            })
            .map_err(|_| ArtifactUploadError::Failed)
    }

    fn finish(
        &self,
        upload_id: &str,
        status: &str,
        document_ids_json: Option<String>,
        error_summary: Option<String>,
    ) -> Result<CodexArtifactUpload, ArtifactUploadError> {
        self.database
            .codex()
            .finish_artifact_upload(
                upload_id,
                status,
                document_ids_json.as_deref(),
                now_ms(),
                error_summary.as_deref(),
            )
            .map_err(|_| ArtifactUploadError::Uncertain)
    }

    fn safe_artifact_path(
        &self,
        project_id: &str,
        relative_path: &str,
    ) -> Result<PathBuf, ArtifactUploadError> {
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        let workspace = layout
            .workspace
            .canonicalize()
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        let candidate = self
            .files
            .resolve_workspace_path(project_id, Path::new(relative_path))
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        let canonical = candidate
            .canonicalize()
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        if !canonical.starts_with(&workspace) || !canonical.is_file() {
            return Err(ArtifactUploadError::InvalidArtifact);
        }
        Ok(canonical)
    }

    fn snapshot_for_upload(
        &self,
        project_id: &str,
        source: &Path,
        expected_hash: &str,
    ) -> Result<UploadSnapshot, ArtifactUploadError> {
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        let directory = layout
            .staging
            .join(format!("artifact-upload-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        let name = source
            .file_name()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| std::ffi::OsStr::new("artifact.bin"));
        let path = directory.join(name);
        if fs::copy(source, &path).is_err() {
            let _ = fs::remove_dir_all(&directory);
            return Err(ArtifactUploadError::InvalidArtifact);
        }
        if sha256_file(&path)? != expected_hash {
            let _ = fs::remove_dir_all(&directory);
            return Err(ArtifactUploadError::SourceChanged);
        }
        Ok(UploadSnapshot { path, directory })
    }
}

fn sha256_file(path: &Path) -> Result<String, ArtifactUploadError> {
    let mut file = File::open(path).map_err(|_| ArtifactUploadError::InvalidArtifact)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ArtifactUploadError::InvalidArtifact)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}
