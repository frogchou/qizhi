use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

use thiserror::Error;
use uuid::Uuid;

use crate::{
    codex::{
        CodexProjectFiles, HandoffFileSource, ProjectFileError,
        ragflow_materials::RagflowPreparationStore,
    },
    contracts::{
        CodexHandoffPreview, CodexHandoffPreviewItem, CodexHandoffResult, CommitCodexHandoffInput,
    },
    database::{AppError, Database, repositories::codex_repository::CommitHandoffMaterialInput},
    scan::{
        configuration::ScanRuleStore,
        file_filter::FileTypeFilter,
        policy::{ScanPolicy, active_roots},
    },
    today_workspace::WorkspaceQueryStore,
};

const PREPARATION_TTL: Duration = Duration::from_secs(10 * 60);
const LARGE_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Debug)]
struct PreparedLocalFile {
    file_id: i64,
    canonical_path: PathBuf,
    file_identity: String,
    display_name: String,
    size_bytes: u64,
    modified_at_utc_ms: i64,
    source_label: String,
}

#[derive(Clone, Debug)]
struct StoredPreparation {
    created_at: Instant,
    source_kind: String,
    files: Vec<PreparedLocalFile>,
    preview: CodexHandoffPreview,
}

#[derive(Clone)]
pub struct CodexHandoffPreparationStore {
    entries: Arc<Mutex<HashMap<String, StoredPreparation>>>,
    time_to_live: Duration,
}

impl Default for CodexHandoffPreparationStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexHandoffPreparationStore {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            time_to_live: PREPARATION_TTL,
        }
    }

    fn insert(&self, preparation: StoredPreparation) -> Result<(), CodexHandoffServiceError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        entries.retain(|_, value| value.created_at.elapsed() < self.time_to_live);
        entries.insert(preparation.preview.preparation_id.clone(), preparation);
        Ok(())
    }

    fn get(&self, id: &str) -> Result<StoredPreparation, CodexHandoffServiceError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        entries.retain(|_, value| value.created_at.elapsed() < self.time_to_live);
        entries
            .get(id)
            .cloned()
            .ok_or(CodexHandoffServiceError::PreparationExpired)
    }

    fn remove(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(id);
        }
    }
}

#[derive(Clone)]
pub struct CodexHandoffService {
    pub(crate) database: Database,
    pub(crate) files: CodexProjectFiles,
    workspace_queries: WorkspaceQueryStore,
    scan_rules: ScanRuleStore,
    preparations: CodexHandoffPreparationStore,
    pub(crate) ragflow_preparations: RagflowPreparationStore,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CodexHandoffServiceError {
    #[error("当前资料选择已过期，请重新打开发送窗口")]
    PreparationExpired,
    #[error("没有可发送的资料")]
    EmptySelection,
    #[error("资料已被删除或不再允许访问")]
    SourceUnavailable,
    #[error("资料在确认后发生了变化，请刷新后重试")]
    SourceChanged,
    #[error("所选资料包含不支持的旧版 Office 文件")]
    BlockedSource,
    #[error("需要确认复制超过 50 MB 的资料")]
    LargeFileConfirmationRequired,
    #[error("文档无法解析，需要确认仅发送原文件")]
    OriginalOnlyConfirmationRequired,
    #[error("Codex 项目正在执行任务，暂时不能修改资料")]
    ProjectBusy,
    #[error("相同请求正在处理中")]
    RequestInProgress,
    #[error("该请求已失败，请重新发起")]
    RequestCannotReuse,
    #[error("资料交接暂时不可用")]
    Unavailable,
}

impl CodexHandoffService {
    pub fn new(
        database: Database,
        files: CodexProjectFiles,
        workspace_queries: WorkspaceQueryStore,
        scan_rules: ScanRuleStore,
        preparations: CodexHandoffPreparationStore,
    ) -> Self {
        Self {
            database,
            files,
            workspace_queries,
            scan_rules,
            preparations,
            ragflow_preparations: RagflowPreparationStore::new(),
        }
    }

    pub fn prepare_today(
        &self,
        query_id: &str,
        file_ids: &[i64],
        directory_ids: &[String],
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        self.prepare_local("today", query_id, file_ids, directory_ids)
    }

    pub fn prepare_recent(
        &self,
        query_id: &str,
        file_ids: &[i64],
        directory_ids: &[String],
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        self.prepare_local("recent", query_id, file_ids, directory_ids)
    }

    fn prepare_local(
        &self,
        source_kind: &str,
        query_id: &str,
        file_ids: &[i64],
        directory_ids: &[String],
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        let ids = self
            .workspace_queries
            .resolve(query_id, file_ids, directory_ids)
            .map_err(|_| CodexHandoffServiceError::PreparationExpired)?;
        if ids.is_empty() {
            return Err(CodexHandoffServiceError::EmptySelection);
        }
        let (policy, filter) = self.current_policy()?;
        let mut prepared = Vec::with_capacity(ids.len());
        for file_id in ids {
            let record = self
                .database
                .files()
                .get_by_id(file_id)
                .map_err(|_| CodexHandoffServiceError::Unavailable)?
                .ok_or(CodexHandoffServiceError::SourceUnavailable)?;
            let path = PathBuf::from(&record.canonical_path);
            if !policy.is_allowed(&path) || !filter.allows(&path) {
                return Err(CodexHandoffServiceError::SourceUnavailable);
            }
            let metadata =
                fs::metadata(&path).map_err(|_| CodexHandoffServiceError::SourceUnavailable)?;
            if !metadata.is_file() {
                return Err(CodexHandoffServiceError::SourceUnavailable);
            }
            prepared.push(PreparedLocalFile {
                file_id,
                canonical_path: path.clone(),
                file_identity: record.file_identity,
                display_name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("资料")
                    .to_owned(),
                size_bytes: metadata.len(),
                modified_at_utc_ms: modified_at_ms(&metadata),
                source_label: record.source,
            });
        }
        prepared.sort_by_key(|file| file.file_id);
        let preparation_id = Uuid::new_v4().to_string();
        let preview_items = prepared
            .iter()
            .take(5)
            .map(preview_item)
            .collect::<Vec<_>>();
        let blocked_items = prepared
            .iter()
            .filter(|file| is_legacy_office(&file.canonical_path))
            .map(preview_item)
            .collect::<Vec<_>>();
        let warning_items = prepared
            .iter()
            .filter(|file| file.size_bytes > LARGE_FILE_BYTES)
            .map(preview_item)
            .collect::<Vec<_>>();
        let preview = CodexHandoffPreview {
            preparation_id,
            source_kind: source_kind.to_owned(),
            file_count: prepared.len(),
            total_size_bytes: prepared.iter().map(|file| file.size_bytes as i64).sum(),
            preview_items,
            requires_large_file_confirmation: !warning_items.is_empty(),
            blocked_items,
            warning_items,
        };
        self.preparations.insert(StoredPreparation {
            created_at: Instant::now(),
            source_kind: source_kind.to_owned(),
            files: prepared,
            preview: preview.clone(),
        })?;
        Ok(preview)
    }

    pub fn commit_local(
        &self,
        input: CommitCodexHandoffInput,
    ) -> Result<CodexHandoffResult, CodexHandoffServiceError> {
        if let Some(existing) = self
            .database
            .codex()
            .find_handoff_by_request(input.request_id.trim())
            .map_err(|_| CodexHandoffServiceError::Unavailable)?
        {
            return match existing.handoff.status.as_str() {
                "ready" | "consumed" => Ok(details_result(&existing)),
                "preparing" => Err(CodexHandoffServiceError::RequestInProgress),
                _ => Err(CodexHandoffServiceError::RequestCannotReuse),
            };
        }
        let preparation = self.preparations.get(&input.preparation_id)?;
        if !preparation.preview.blocked_items.is_empty() {
            return Err(CodexHandoffServiceError::BlockedSource);
        }
        if preparation.preview.requires_large_file_confirmation && !input.confirm_large_files {
            return Err(CodexHandoffServiceError::LargeFileConfirmationRequired);
        }
        if self
            .database
            .codex()
            .project_has_active_turn(&input.project_id)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?
        {
            return Err(CodexHandoffServiceError::ProjectBusy);
        }
        let project_is_active = self
            .database
            .codex()
            .list_projects(false)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?
            .iter()
            .any(|project| project.id == input.project_id);
        if !project_is_active {
            return Err(CodexHandoffServiceError::Unavailable);
        }
        let conversation_exists = self
            .database
            .codex()
            .list_conversations(&input.project_id, false)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?
            .iter()
            .any(|conversation| conversation.id == input.conversation_id);
        if !conversation_exists {
            return Err(CodexHandoffServiceError::Unavailable);
        }
        let sources = self.revalidate_sources(&preparation.files)?;
        let staged = self
            .files
            .stage_handoff_files(
                &input.project_id,
                &input.preparation_id,
                &sources,
                input.confirm_large_files,
                input.confirm_original_only,
            )
            .map_err(map_project_file_error)?;
        let handoff = match self.database.codex().create_handoff(
            input.request_id.trim(),
            &preparation.source_kind,
            &input.project_id,
            &input.conversation_id,
            now_ms(),
        ) {
            Ok(handoff) => handoff,
            Err(_) => {
                let _ = self
                    .files
                    .discard_staging(&input.project_id, &input.preparation_id);
                if let Some(existing) = self
                    .database
                    .codex()
                    .find_handoff_by_request(input.request_id.trim())
                    .map_err(|_| CodexHandoffServiceError::Unavailable)?
                    && matches!(existing.handoff.status.as_str(), "ready" | "consumed")
                {
                    return Ok(details_result(&existing));
                }
                return Err(CodexHandoffServiceError::RequestInProgress);
            }
        };
        let committed = match self.files.commit_staged_handoff(
            &input.project_id,
            &input.preparation_id,
            &staged,
        ) {
            Ok(committed) => committed,
            Err(error) => {
                let _ = self
                    .database
                    .codex()
                    .mark_handoff_failed(&handoff.id, "无法保存项目资料");
                return Err(map_project_file_error(error));
            }
        };
        let persist_result = self.persist_committed_files(
            &handoff.id,
            &input.project_id,
            &preparation.files,
            &committed,
        );
        if let Err(error) = persist_result {
            for file in &committed {
                let _ = fs::remove_file(&file.original_snapshot_path);
                if let Some(path) = &file.derived_snapshot_path {
                    let _ = fs::remove_file(path);
                }
            }
            let _ = self
                .database
                .codex()
                .mark_handoff_failed(&handoff.id, "无法记录项目资料");
            return Err(error);
        }
        self.preparations.remove(&input.preparation_id);
        let details = self
            .database
            .codex()
            .find_handoff_by_request(input.request_id.trim())
            .map_err(|_| CodexHandoffServiceError::Unavailable)?
            .ok_or(CodexHandoffServiceError::Unavailable)?;
        Ok(details_result(&details))
    }

    pub fn recover(&self) -> Result<usize, CodexHandoffServiceError> {
        self.database
            .codex()
            .recover_interrupted_handoffs(now_ms())
            .map_err(|_| CodexHandoffServiceError::Unavailable)
    }

    fn current_policy(&self) -> Result<(ScanPolicy, FileTypeFilter), CodexHandoffServiceError> {
        let rules = self
            .scan_rules
            .get()
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        let exclusions = rules
            .custom_exclusions
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let roots = active_roots(&rules.allowed_roots, &exclusions)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        Ok((
            ScanPolicy::for_roots(exclusions, roots),
            FileTypeFilter::new(rules.file_categories),
        ))
    }

    fn revalidate_sources(
        &self,
        prepared: &[PreparedLocalFile],
    ) -> Result<Vec<HandoffFileSource>, CodexHandoffServiceError> {
        let (policy, filter) = self.current_policy()?;
        prepared
            .iter()
            .map(|source| {
                let record = self
                    .database
                    .files()
                    .get_by_id(source.file_id)
                    .map_err(|_| CodexHandoffServiceError::Unavailable)?
                    .ok_or(CodexHandoffServiceError::SourceUnavailable)?;
                if Path::new(&record.canonical_path) != source.canonical_path
                    || record.file_identity != source.file_identity
                    || !policy.is_allowed(&source.canonical_path)
                    || !filter.allows(&source.canonical_path)
                {
                    return Err(CodexHandoffServiceError::SourceUnavailable);
                }
                let metadata = fs::metadata(&source.canonical_path)
                    .map_err(|_| CodexHandoffServiceError::SourceUnavailable)?;
                if metadata.len() != source.size_bytes
                    || modified_at_ms(&metadata) != source.modified_at_utc_ms
                {
                    return Err(CodexHandoffServiceError::SourceChanged);
                }
                Ok(HandoffFileSource {
                    source_path: source.canonical_path.clone(),
                    expected_size_bytes: source.size_bytes,
                    expected_modified_at_utc_ms: source.modified_at_utc_ms,
                })
            })
            .collect()
    }

    fn persist_committed_files(
        &self,
        handoff_id: &str,
        project_id: &str,
        prepared: &[PreparedLocalFile],
        committed: &[crate::codex::CommittedHandoffFile],
    ) -> Result<(), CodexHandoffServiceError> {
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(map_project_file_error)?;
        let mut items = Vec::with_capacity(committed.len());
        for (index, (source, file)) in prepared.iter().zip(committed).enumerate() {
            let origin_reference = format!("local:{}:{}", source.file_id, source.file_identity);
            let metadata = serde_json::json!({
                "fileId": source.file_id,
                "fileIdentity": source.file_identity,
                "modifiedAtUtcMs": source.modified_at_utc_ms,
                "source": source.source_label,
            })
            .to_string();
            let original_snapshot_path = file
                .original_snapshot_path
                .strip_prefix(&layout.root)
                .map_err(|_| CodexHandoffServiceError::Unavailable)?
                .to_string_lossy()
                .replace('\\', "/");
            let derived_snapshot_path = file
                .derived_snapshot_path
                .as_ref()
                .and_then(|path| path.strip_prefix(&layout.root).ok())
                .map(|path| path.to_string_lossy().replace('\\', "/"));
            items.push(CommitHandoffMaterialInput {
                kind: "local".to_owned(),
                origin_reference,
                display_name: source.display_name.clone(),
                source_metadata_json: metadata,
                original_snapshot_path,
                derived_snapshot_path,
                content_hash: file.content_hash.clone(),
                size_bytes: file.size_bytes as i64,
                mime_type: mime_type_for(&file.source_path).to_owned(),
                extractor_version: "qizhi-1".to_owned(),
                created_at_utc_ms: now_ms(),
                display_order: index as i64,
            });
        }
        let reused = self
            .database
            .codex()
            .commit_handoff_materials(handoff_id, project_id, &items)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        for (file, reused) in committed.iter().zip(reused) {
            if reused {
                let _ = fs::remove_file(&file.original_snapshot_path);
                if let Some(path) = &file.derived_snapshot_path {
                    let _ = fs::remove_file(path);
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn details_result(
    details: &crate::contracts::CodexHandoffDetails,
) -> CodexHandoffResult {
    CodexHandoffResult {
        handoff_id: details.handoff.id.clone(),
        project_id: details.handoff.project_id.clone(),
        conversation_id: details.handoff.conversation_id.clone(),
        item_count: details.items.len(),
        status: details.handoff.status.clone(),
    }
}

fn preview_item(file: &PreparedLocalFile) -> CodexHandoffPreviewItem {
    CodexHandoffPreviewItem {
        file_id: file.file_id,
        display_name: file.display_name.clone(),
        size_bytes: file.size_bytes as i64,
    }
}

fn is_legacy_office(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "doc" | "xls" | "ppt"
            )
        })
}

fn modified_at_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn map_project_file_error(error: ProjectFileError) -> CodexHandoffServiceError {
    match error {
        ProjectFileError::SourceChanged => CodexHandoffServiceError::SourceChanged,
        ProjectFileError::LargeFileConfirmationRequired => {
            CodexHandoffServiceError::LargeFileConfirmationRequired
        }
        ProjectFileError::OriginalOnlyConfirmationRequired => {
            CodexHandoffServiceError::OriginalOnlyConfirmationRequired
        }
        ProjectFileError::UnsupportedFormat(_) => CodexHandoffServiceError::BlockedSource,
        ProjectFileError::UnsafePath | ProjectFileError::Io => {
            CodexHandoffServiceError::SourceUnavailable
        }
        ProjectFileError::InvalidProjectId | ProjectFileError::Extraction => {
            CodexHandoffServiceError::Unavailable
        }
    }
}

fn mime_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" | "csv" | "tsv" | "rs" | "py" | "js" | "ts" | "json" => "text/plain",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

impl From<AppError> for CodexHandoffServiceError {
    fn from(_: AppError) -> Self {
        Self::Unavailable
    }
}
