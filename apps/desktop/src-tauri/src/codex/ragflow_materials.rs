use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    codex::{
        CodexHandoffService, CodexHandoffServiceError, CommittedHandoffFile,
        handoff::details_result,
    },
    contracts::{
        CodexHandoffPreview, CodexHandoffPreviewItem, CodexHandoffResult, CodexRagflowAnswerInput,
        CodexRagflowChunkInput, CodexRagflowDocumentInput, CommitCodexHandoffInput,
    },
    database::repositories::codex_repository::CommitHandoffMaterialInput,
    jev::extract_document_text,
    ragflow::client::RagflowClient,
};

const REMOTE_PREPARATION_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_CHUNKS: usize = 100;
const MAX_CHUNK_CHARS: usize = 100_000;
const MAX_ANSWER_BYTES: usize = 1024 * 1024;

fn mime_type_for_path(path: &std::path::Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
    .to_owned()
}

pub trait RagflowDocumentDownloader: Send + Sync {
    fn download(&self, dataset_id: &str, document_id: &str) -> Result<Vec<u8>, String>;
}

impl RagflowDocumentDownloader for RagflowClient {
    fn download(&self, dataset_id: &str, document_id: &str) -> Result<Vec<u8>, String> {
        self.download_document(dataset_id, document_id)
    }
}

#[derive(Clone)]
pub(crate) struct RagflowPreparationStore {
    entries: Arc<Mutex<HashMap<String, StoredRagflowPreparation>>>,
}

impl RagflowPreparationStore {
    pub(crate) fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn insert(&self, value: StoredRagflowPreparation) -> Result<(), CodexHandoffServiceError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        entries.retain(|_, item| item.created_at.elapsed() < REMOTE_PREPARATION_TTL);
        entries.insert(value.preview.preparation_id.clone(), value);
        Ok(())
    }

    fn get(&self, id: &str) -> Result<StoredRagflowPreparation, CodexHandoffServiceError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        entries.retain(|_, item| item.created_at.elapsed() < REMOTE_PREPARATION_TTL);
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
struct StoredRagflowPreparation {
    created_at: Instant,
    source_kind: String,
    items: Vec<PreparedRagflowItem>,
    preview: CodexHandoffPreview,
}

#[derive(Clone)]
struct PreparedRagflowItem {
    kind: String,
    display_name: String,
    origin_reference: String,
    source_metadata_json: String,
    payload: RagflowPayload,
}

#[derive(Clone)]
enum RagflowPayload {
    Markdown(String),
    Document {
        dataset_id: String,
        document_id: String,
    },
}

struct ResolvedRagflowItem {
    prepared: PreparedRagflowItem,
    bytes: Vec<u8>,
}

impl CodexHandoffService {
    pub fn prepare_ragflow_chunks(
        &self,
        question: &str,
        chunks: Vec<CodexRagflowChunkInput>,
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        if question.trim().is_empty() || chunks.is_empty() || chunks.len() > MAX_CHUNKS {
            return Err(CodexHandoffServiceError::EmptySelection);
        }
        let mut items = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            if !valid_resource_id(&chunk.chunk_id)
                || !valid_resource_id(&chunk.document_id)
                || !valid_resource_id(&chunk.dataset_id)
                || chunk.content.chars().count() > MAX_CHUNK_CHARS
            {
                return Err(CodexHandoffServiceError::Unavailable);
            }
            let markdown = render_ragflow_chunk_markdown(question, &chunk);
            let metadata = serde_json::json!({
                "datasetId": chunk.dataset_id,
                "documentId": chunk.document_id,
                "chunkId": chunk.chunk_id,
                "documentName": clean_text(&chunk.document_name, 500),
                "similarity": chunk.similarity,
                "retrievedAtUtcMs": chunk.retrieved_at_utc_ms,
                "verification": "retrieved_chunk",
            })
            .to_string();
            items.push(PreparedRagflowItem {
                kind: "ragflow_chunk".to_owned(),
                display_name: clean_text(&chunk.document_name, 500),
                origin_reference: format!(
                    "ragflow:chunk:{}:{}:{}",
                    chunk.dataset_id, chunk.document_id, chunk.chunk_id
                ),
                source_metadata_json: metadata,
                payload: RagflowPayload::Markdown(markdown),
            });
        }
        self.store_remote_preparation("ragflow_chunks", items)
    }

    pub fn prepare_ragflow_documents(
        &self,
        documents: Vec<CodexRagflowDocumentInput>,
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        for document in documents {
            if !valid_resource_id(&document.dataset_id) || !valid_resource_id(&document.document_id)
            {
                return Err(CodexHandoffServiceError::Unavailable);
            }
            if !seen.insert((document.dataset_id.clone(), document.document_id.clone())) {
                continue;
            }
            let display_name = sanitize_file_name(&document.document_name);
            let metadata = serde_json::json!({
                "datasetId": document.dataset_id,
                "documentId": document.document_id,
                "documentName": clean_text(&document.document_name, 500),
                "retrievedAtUtcMs": document.retrieved_at_utc_ms,
                "verification": "ragflow_document",
            })
            .to_string();
            items.push(PreparedRagflowItem {
                kind: "ragflow_document".to_owned(),
                display_name,
                origin_reference: format!(
                    "ragflow:document:{}:{}",
                    document.dataset_id, document.document_id
                ),
                source_metadata_json: metadata,
                payload: RagflowPayload::Document {
                    dataset_id: document.dataset_id,
                    document_id: document.document_id,
                },
            });
        }
        if items.is_empty() {
            return Err(CodexHandoffServiceError::EmptySelection);
        }
        self.store_remote_preparation("ragflow_document", items)
    }

    pub fn prepare_ragflow_answer(
        &self,
        answer: CodexRagflowAnswerInput,
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        if answer.question.trim().is_empty()
            || answer.agent_id.trim().is_empty()
            || answer.agent_name.trim().is_empty()
            || answer.final_answer.trim().is_empty()
            || answer.final_answer.len() > MAX_ANSWER_BYTES
        {
            return Err(CodexHandoffServiceError::EmptySelection);
        }
        if answer.references.iter().any(|reference| {
            !valid_resource_id(&reference.dataset_id)
                || !valid_resource_id(&reference.document_id)
                || !valid_resource_id(&reference.chunk_id)
                || reference.content.chars().count() > MAX_CHUNK_CHARS
        }) {
            return Err(CodexHandoffServiceError::Unavailable);
        }
        let verification = if answer.references.is_empty() {
            "unverified_answer"
        } else {
            "answer_with_references"
        };
        let metadata = serde_json::json!({
            "agentId": clean_text(&answer.agent_id, 500),
            "agentName": clean_text(&answer.agent_name, 500),
            "retrievedAtUtcMs": answer.retrieved_at_utc_ms,
            "verification": verification,
            "referenceCount": answer.references.len(),
        })
        .to_string();
        let preparation_id = Uuid::new_v4().to_string();
        let markdown = render_ragflow_answer_markdown(&answer);
        let item = PreparedRagflowItem {
            kind: "ragflow_answer".to_owned(),
            display_name: format!("{} 的回答.md", clean_text(&answer.agent_name, 120)),
            origin_reference: format!(
                "ragflow:answer:{}:{}",
                clean_text(&answer.agent_id, 200),
                preparation_id
            ),
            source_metadata_json: metadata,
            payload: RagflowPayload::Markdown(markdown),
        };
        self.store_remote_preparation_with_id("ragflow_answer", vec![item], preparation_id)
    }

    pub fn commit_ragflow(
        &self,
        input: CommitCodexHandoffInput,
        downloader: &dyn RagflowDocumentDownloader,
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
        let preparation = self.ragflow_preparations.get(&input.preparation_id)?;
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
        let mut resolved = Vec::with_capacity(preparation.items.len());
        for item in &preparation.items {
            let bytes = match &item.payload {
                RagflowPayload::Markdown(markdown) => markdown.as_bytes().to_vec(),
                RagflowPayload::Document {
                    dataset_id,
                    document_id,
                } => downloader
                    .download(dataset_id, document_id)
                    .map_err(|_| CodexHandoffServiceError::Unavailable)?,
            };
            if bytes.is_empty() {
                return Err(CodexHandoffServiceError::Unavailable);
            }
            resolved.push(ResolvedRagflowItem {
                prepared: item.clone(),
                bytes,
            });
        }
        let staged = self.stage_remote_items(
            &input.project_id,
            &input.preparation_id,
            &resolved,
            input.confirm_original_only,
        )?;
        let handoff = self
            .database
            .codex()
            .create_handoff(
                input.request_id.trim(),
                &preparation.source_kind,
                &input.project_id,
                &input.conversation_id,
                now_ms(),
            )
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        let persist =
            self.persist_remote_files(&handoff.id, &input.project_id, &preparation.items, &staged);
        if let Err(error) = persist {
            let _ = self
                .database
                .codex()
                .mark_handoff_failed(&handoff.id, "无法记录知识库资料");
            return Err(error);
        }
        self.ragflow_preparations.remove(&input.preparation_id);
        let details = self
            .database
            .codex()
            .find_handoff_by_request(input.request_id.trim())
            .map_err(|_| CodexHandoffServiceError::Unavailable)?
            .ok_or(CodexHandoffServiceError::Unavailable)?;
        Ok(details_result(&details))
    }

    fn store_remote_preparation(
        &self,
        source_kind: &str,
        items: Vec<PreparedRagflowItem>,
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        self.store_remote_preparation_with_id(source_kind, items, Uuid::new_v4().to_string())
    }

    fn store_remote_preparation_with_id(
        &self,
        source_kind: &str,
        items: Vec<PreparedRagflowItem>,
        preparation_id: String,
    ) -> Result<CodexHandoffPreview, CodexHandoffServiceError> {
        let preview_items = items
            .iter()
            .take(5)
            .enumerate()
            .map(|(index, item)| CodexHandoffPreviewItem {
                file_id: -(index as i64) - 1,
                display_name: item.display_name.clone(),
                size_bytes: match &item.payload {
                    RagflowPayload::Markdown(text) => text.len() as i64,
                    RagflowPayload::Document { .. } => 0,
                },
            })
            .collect::<Vec<_>>();
        let preview = CodexHandoffPreview {
            preparation_id,
            source_kind: source_kind.to_owned(),
            file_count: items.len(),
            total_size_bytes: preview_items.iter().map(|item| item.size_bytes).sum(),
            preview_items,
            blocked_items: vec![],
            warning_items: vec![],
            requires_large_file_confirmation: false,
        };
        self.ragflow_preparations.insert(StoredRagflowPreparation {
            created_at: Instant::now(),
            source_kind: source_kind.to_owned(),
            items,
            preview: preview.clone(),
        })?;
        Ok(preview)
    }

    fn stage_remote_items(
        &self,
        project_id: &str,
        preparation_id: &str,
        items: &[ResolvedRagflowItem],
        confirm_original_only: bool,
    ) -> Result<Vec<CommittedHandoffFile>, CodexHandoffServiceError> {
        Uuid::parse_str(preparation_id).map_err(|_| CodexHandoffServiceError::Unavailable)?;
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        let staging = layout.staging.join(preparation_id);
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|_| CodexHandoffServiceError::Unavailable)?;
        }
        fs::create_dir_all(&staging).map_err(|_| CodexHandoffServiceError::Unavailable)?;
        let result = (|| {
            let mut committed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let name = sanitize_file_name(&item.prepared.display_name);
                let staged_original = staging.join(format!("{index:04}-{name}"));
                fs::write(&staged_original, &item.bytes)
                    .map_err(|_| CodexHandoffServiceError::Unavailable)?;
                let hash = format!("{:x}", Sha256::digest(&item.bytes));
                let derived = if matches!(item.prepared.payload, RagflowPayload::Document { .. }) {
                    match extract_document_text(&staged_original, 500_000) {
                        Ok(text) => {
                            let path = staging.join(format!("{index:04}-{name}.derived.md"));
                            fs::write(&path, text)
                                .map_err(|_| CodexHandoffServiceError::Unavailable)?;
                            Some(path)
                        }
                        Err(_) if confirm_original_only => None,
                        Err(_) => {
                            return Err(CodexHandoffServiceError::OriginalOnlyConfirmationRequired);
                        }
                    }
                } else {
                    None
                };
                let destination = layout
                    .materials_ragflow
                    .join(format!("{}-{index:04}-{name}", &preparation_id[..8]));
                fs::rename(&staged_original, &destination)
                    .map_err(|_| CodexHandoffServiceError::Unavailable)?;
                let derived_destination = if let Some(derived) = derived {
                    let destination = destination.with_file_name(format!(
                        "{}.derived.md",
                        destination
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("material")
                    ));
                    fs::rename(derived, &destination)
                        .map_err(|_| CodexHandoffServiceError::Unavailable)?;
                    Some(destination)
                } else {
                    None
                };
                committed.push(CommittedHandoffFile {
                    source_path: PathBuf::from(&name),
                    original_snapshot_path: destination,
                    derived_snapshot_path: derived_destination,
                    content_hash: hash,
                    size_bytes: item.bytes.len() as u64,
                });
            }
            Ok(committed)
        })();
        let _ = fs::remove_dir_all(staging);
        result
    }

    fn persist_remote_files(
        &self,
        handoff_id: &str,
        project_id: &str,
        prepared: &[PreparedRagflowItem],
        files: &[CommittedHandoffFile],
    ) -> Result<(), CodexHandoffServiceError> {
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(|_| CodexHandoffServiceError::Unavailable)?;
        let mut items = Vec::with_capacity(files.len());
        for (index, (prepared, file)) in prepared.iter().zip(files).enumerate() {
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
                kind: prepared.kind.clone(),
                origin_reference: prepared.origin_reference.clone(),
                display_name: prepared.display_name.clone(),
                source_metadata_json: prepared.source_metadata_json.clone(),
                original_snapshot_path,
                derived_snapshot_path,
                content_hash: file.content_hash.clone(),
                size_bytes: file.size_bytes as i64,
                mime_type: mime_type_for_path(&file.source_path),
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
        for (file, reused) in files.iter().zip(reused) {
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

pub fn render_ragflow_chunk_markdown(question: &str, chunk: &CodexRagflowChunkInput) -> String {
    format!(
        "# RAGFlow 检索片段\n\n- 查询：{}\n- Dataset ID：{}\n- Document ID：{}\n- Chunk ID：{}\n- 文档：{}\n- 相关度：{:.4}\n- 检索时间：{}\n\n## 内容\n\n{}\n",
        clean_text(question, 20_000),
        clean_text(&chunk.dataset_id, 500),
        clean_text(&chunk.document_id, 500),
        clean_text(&chunk.chunk_id, 500),
        clean_text(&chunk.document_name, 500),
        chunk.similarity,
        chunk.retrieved_at_utc_ms,
        clean_text(&chunk.content, MAX_CHUNK_CHARS),
    )
}

pub fn render_ragflow_answer_markdown(answer: &CodexRagflowAnswerInput) -> String {
    let mut markdown = format!(
        "# RAGFlow Agent 最终回答\n\n- Agent：{}\n- Agent ID：{}\n- 检索时间：{}\n\n## 问题\n\n{}\n\n## 最终回答\n\n{}\n",
        clean_text(&answer.agent_name, 500),
        clean_text(&answer.agent_id, 500),
        answer.retrieved_at_utc_ms,
        clean_text(&answer.question, 20_000),
        clean_text(&answer.final_answer, MAX_ANSWER_BYTES),
    );
    if answer.references.is_empty() {
        markdown.push_str("\n> 该回答没有可验证引用。\n");
    } else {
        markdown.push_str("\n## 引用\n");
        let mut seen = HashSet::new();
        for reference in &answer.references {
            let key = format!(
                "{}:{}:{}",
                reference.dataset_id, reference.document_id, reference.chunk_id
            );
            if !seen.insert(key) {
                continue;
            }
            markdown.push_str(&format!(
                "\n### {} · {}\n\n- Dataset ID：{}\n- Document ID：{}\n- Chunk ID：{}\n- 相关度：{:.4}\n\n{}\n",
                clean_text(&reference.citation_id, 200),
                clean_text(&reference.document_name, 500),
                clean_text(&reference.dataset_id, 500),
                clean_text(&reference.document_id, 500),
                clean_text(&reference.chunk_id, 500),
                reference.similarity,
                clean_text(&reference.content, MAX_CHUNK_CHARS),
            ));
        }
    }
    markdown
}

fn valid_resource_id(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains(['/', '\\', '\0'])
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .replace('\r', "")
}

fn sanitize_file_name(value: &str) -> String {
    let cleaned = clean_text(value, 180)
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim_matches([' ', '.']);
    if cleaned.is_empty() {
        "ragflow-material.md".to_owned()
    } else {
        cleaned.to_owned()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}
