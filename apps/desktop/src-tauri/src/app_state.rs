use crate::{
    codex::{CodexHandoffService, CodexRuntime},
    database::Database,
    knowledge_selection::KnowledgeSelectionStore,
    scan::{configuration::ScanRuleStore, progress::TodayScanProgress},
    telemetry::AppLogger,
    today_workspace::WorkspaceQueryStore,
};

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub scan_rules: ScanRuleStore,
    pub today_scan_progress: TodayScanProgress,
    pub logger: AppLogger,
    pub workspace_queries: WorkspaceQueryStore,
    pub codex_runtime: CodexRuntime,
    pub codex_handoffs: CodexHandoffService,
    pub knowledge_selections: KnowledgeSelectionStore,
}
