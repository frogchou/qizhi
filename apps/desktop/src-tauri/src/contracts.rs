#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRecordInput {
    pub canonical_path: String,
    pub file_identity: String,
    pub modified_at_utc_ms: i64,
    pub size_bytes: i64,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalDayRange {
    pub start_utc_ms: i64,
    pub next_start_utc_ms: i64,
}

impl LocalDayRange {
    pub fn new(start_utc_ms: i64, next_start_utc_ms: i64) -> Self {
        Self {
            start_utc_ms,
            next_start_utc_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRecord {
    pub id: i64,
    pub canonical_path: String,
    pub file_identity: String,
    pub modified_at_utc_ms: i64,
    pub size_bytes: i64,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodayCluster {
    pub label: String,
    pub file_ids: Vec<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanSkip {
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodaySnapshot {
    pub files: Vec<FileRecord>,
    pub clusters: Vec<TodayCluster>,
    pub skipped: Vec<ScanSkip>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskedServiceConfig {
    pub service: String,
    pub endpoint: String,
    pub api_key_mask: String,
    pub credential_reference: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileValueAssessmentInput {
    pub canonical_path: String,
    pub file_identity: String,
    pub modified_at_utc_ms: i64,
    pub status: String,
    pub score: Option<f64>,
    pub confidence: Option<f64>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileValueAssessment {
    pub canonical_path: String,
    pub file_identity: String,
    pub modified_at_utc_ms: i64,
    pub status: String,
    pub score: Option<f64>,
    pub confidence: Option<f64>,
    pub message: Option<String>,
    pub evaluated_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JevValuePolicyInput {
    pub instructions: String,
    pub criteria: Vec<String>,
    pub valuable_threshold: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevValuePolicy {
    pub instructions: String,
    pub criteria: Vec<String>,
    pub valuable_threshold: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPromptTemplate {
    pub id: i64,
    pub title: String,
    pub prompt: String,
    pub sort_order: i64,
    pub is_default: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPromptTemplateInput {
    pub id: Option<i64>,
    pub title: String,
    pub prompt: String,
    pub sort_order: i64,
    pub is_default: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarySettings {
    pub model: String,
    pub templates: Vec<SummaryPromptTemplate>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarySettingsInput {
    pub model: String,
    pub templates: Vec<SummaryPromptTemplateInput>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProject {
    pub id: String,
    pub name: String,
    pub goal: Option<String>,
    pub root_path: String,
    pub status: String,
    pub created_at_utc_ms: i64,
    pub updated_at_utc_ms: i64,
    pub last_opened_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub codex_thread_id: Option<String>,
    pub codex_session_id: Option<String>,
    pub status: String,
    pub created_at_utc_ms: i64,
    pub updated_at_utc_ms: i64,
    pub archived_at_utc_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMessage {
    pub id: String,
    pub turn_id: String,
    pub role: String,
    pub markdown: String,
    pub status: String,
    pub created_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessItem {
    pub id: String,
    pub turn_id: String,
    pub codex_item_id: String,
    pub kind: String,
    pub title: String,
    pub safe_summary: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProcessItemInput {
    pub turn_id: String,
    pub codex_item_id: String,
    pub kind: String,
    pub title: String,
    pub safe_summary: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnProjection {
    pub id: String,
    pub conversation_id: String,
    pub codex_turn_id: Option<String>,
    pub user_text: String,
    pub status: String,
    pub started_at_utc_ms: i64,
    pub completed_at_utc_ms: Option<i64>,
    pub error_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnHistory {
    #[serde(flatten)]
    pub turn: CodexTurnProjection,
    pub messages: Vec<CodexMessage>,
    pub process_items: Vec<CodexProcessItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConversationHistory {
    pub conversation: CodexConversation,
    pub turns: Vec<CodexTurnHistory>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMaterial {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub display_name: String,
    pub origin_reference: Option<String>,
    pub source_metadata_json: Option<String>,
    pub current_version_id: Option<String>,
    pub snapshot_state: String,
    pub imported_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMaterialSourceStatus {
    pub material_id: String,
    pub state: String,
    pub source_label: String,
    pub refreshable: bool,
    pub revealable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMaterialVersion {
    pub id: String,
    pub material_id: String,
    pub original_snapshot_path: String,
    pub derived_snapshot_path: Option<String>,
    pub content_hash: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub extractor_version: Option<String>,
    pub created_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMaterialVersionInput {
    pub material_id: String,
    pub original_snapshot_path: String,
    pub derived_snapshot_path: Option<String>,
    pub content_hash: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub extractor_version: Option<String>,
    pub created_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoff {
    pub id: String,
    pub request_id: String,
    pub source_kind: String,
    pub project_id: String,
    pub conversation_id: String,
    pub status: String,
    pub created_at_utc_ms: i64,
    pub consumed_at_utc_ms: Option<i64>,
    pub error_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffItem {
    pub id: String,
    pub handoff_id: String,
    pub material_id: String,
    pub material_version_id: String,
    pub display_name: String,
    pub source_metadata_json: String,
    pub display_order: i64,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffDetails {
    pub handoff: CodexHandoff,
    pub items: Vec<CodexHandoffItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffItemInput {
    pub material_id: String,
    pub material_version_id: String,
    pub display_name: String,
    pub source_metadata_json: String,
    pub display_order: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffPreviewItem {
    pub file_id: i64,
    pub display_name: String,
    pub size_bytes: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffPreview {
    pub preparation_id: String,
    pub source_kind: String,
    pub file_count: usize,
    pub total_size_bytes: i64,
    pub preview_items: Vec<CodexHandoffPreviewItem>,
    pub blocked_items: Vec<CodexHandoffPreviewItem>,
    pub warning_items: Vec<CodexHandoffPreviewItem>,
    pub requires_large_file_confirmation: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCodexHandoffInput {
    pub preparation_id: String,
    pub request_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub confirm_large_files: bool,
    pub confirm_original_only: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHandoffResult {
    pub handoff_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub item_count: usize,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRagflowChunkInput {
    pub chunk_id: String,
    pub content: String,
    pub document_name: String,
    pub document_id: String,
    pub dataset_id: String,
    pub similarity: f64,
    pub retrieved_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRagflowDocumentInput {
    pub dataset_id: String,
    pub document_id: String,
    pub document_name: String,
    pub retrieved_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRagflowReferenceInput {
    pub citation_id: String,
    pub chunk_id: String,
    pub content: String,
    pub document_name: String,
    pub document_id: String,
    pub dataset_id: String,
    pub similarity: f64,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRagflowAnswerInput {
    pub question: String,
    pub agent_id: String,
    pub agent_name: String,
    pub final_answer: String,
    pub retrieved_at_utc_ms: i64,
    pub references: Vec<CodexRagflowReferenceInput>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexArtifact {
    pub id: String,
    pub project_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub created_by_conversation_id: Option<String>,
    pub created_by_turn_id: Option<String>,
    pub detected_at_utc_ms: i64,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexArtifactInput {
    pub project_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub created_by_conversation_id: Option<String>,
    pub created_by_turn_id: Option<String>,
    pub detected_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexArtifactUpload {
    pub id: String,
    pub artifact_id: String,
    pub dataset_id: String,
    pub parent_path: Option<String>,
    pub content_hash: String,
    pub document_ids_json: Option<String>,
    pub status: String,
    pub start_parsing: bool,
    pub created_at_utc_ms: i64,
    pub completed_at_utc_ms: Option<i64>,
    pub error_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexArtifactUploadInput {
    pub artifact_id: String,
    pub dataset_id: String,
    pub parent_path: Option<String>,
    pub content_hash: String,
    pub document_ids_json: Option<String>,
    pub status: String,
    pub start_parsing: bool,
    pub created_at_utc_ms: i64,
    pub completed_at_utc_ms: Option<i64>,
    pub error_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRecord {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub action_type: String,
    pub target_summary: String,
    pub decision: String,
    pub created_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalInput {
    pub project_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub action_type: String,
    pub target_summary: String,
    pub decision: String,
    pub created_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPreferences {
    pub model: String,
    pub reasoning_effort: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCodexTurnInput {
    pub project_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub handoff_ids: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnResult {
    pub local_turn_id: String,
    pub codex_turn_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexTurnEvent {
    Started {
        project_id: String,
        conversation_id: String,
        local_turn_id: String,
        codex_turn_id: String,
    },
    MessageDelta {
        local_turn_id: String,
        delta: String,
    },
    ProcessItem {
        local_turn_id: String,
        item_id: String,
        kind: String,
        title: String,
        summary: String,
        status: String,
    },
    ApprovalRequested {
        local_turn_id: String,
        request_id: String,
        item_id: String,
        action_type: String,
        target_summary: String,
    },
    Completed {
        local_turn_id: String,
        status: String,
        error: Option<String>,
        artifacts: Vec<CodexArtifact>,
    },
}
