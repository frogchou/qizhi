use crate::{
    codex::{CodexHandoffService, CodexRuntime},
    database::Database,
    file_index::WorkspaceFileIndex,
    knowledge_selection::KnowledgeSelectionStore,
    scan::{configuration::ScanRuleStore, progress::TodayScanProgress},
    telemetry::AppLogger,
    today_workspace::WorkspaceQueryStore,
};

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub scan_rules: ScanRuleStore,
    pub file_index: WorkspaceFileIndex,
    pub today_scan_progress: TodayScanProgress,
    pub logger: AppLogger,
    pub workspace_queries: WorkspaceQueryStore,
    pub codex_runtime: CodexRuntime,
    pub codex_handoffs: CodexHandoffService,
    pub knowledge_selections: KnowledgeSelectionStore,
}
