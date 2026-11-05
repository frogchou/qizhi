pub mod app_state;
pub mod codex;
pub mod commands;
pub mod config;
pub mod contracts;
pub mod database;
pub mod jev;
pub mod knowledge_selection;
pub mod network;
pub mod ntfs;
pub mod openai;
pub mod ragflow;
pub mod scan;
pub mod system;
pub mod telemetry;
pub mod today_workspace;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("app data directory");
            std::fs::create_dir_all(&data_dir).expect("create app data directory");
            let database =
                database::Database::open(&data_dir.join("qizhi.db")).expect("open local database");
            let scan_rules = scan::configuration::ScanRuleStore::open(
                &data_dir.join("scan-rules.json"),
                scan::configuration::ScanRules::defaults_for_current_user(),
            )
            .expect("open scan rules");
            let project_files = codex::CodexProjectFiles::new(data_dir.join("codex-projects"));
            let workspace_queries = today_workspace::WorkspaceQueryStore::new();
            let knowledge_selections = knowledge_selection::KnowledgeSelectionStore::default();
            let codex_handoffs = codex::CodexHandoffService::new(
                database.clone(),
                project_files.clone(),
                workspace_queries.clone(),
                scan_rules.clone(),
                codex::CodexHandoffPreparationStore::new(),
            );
            let _ = codex_handoffs.recover();
            let recovery_now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis() as i64)
                .unwrap_or(0);
            let _ = database
                .codex()
                .recover_interrupted_artifact_uploads(recovery_now);
            let codex_runtime = codex::CodexRuntime::new(database.clone(), project_files);
            app.manage(app_state::AppState {
                database,
                scan_rules,
                today_scan_progress: scan::progress::TodayScanProgress::new(),
                logger: telemetry::AppLogger::new(&data_dir),
                workspace_queries,
                codex_runtime,
                codex_handoffs,
                knowledge_selections,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::codex::get_codex_status,
            commands::codex::refresh_codex_status,
            commands::codex::list_codex_models,
            commands::codex::get_codex_preferences,
            commands::codex::save_codex_preferences,
            commands::codex::list_codex_projects,
            commands::codex::create_codex_project,
            commands::codex::rename_codex_project,
            commands::codex::archive_codex_project,
            commands::codex::list_codex_conversations,
            commands::codex::create_codex_conversation,
            commands::codex::rename_codex_conversation,
            commands::codex::archive_codex_conversation,
            commands::codex::read_codex_conversation,
            commands::codex::list_codex_materials,
            commands::codex::inspect_codex_material_sources,
            commands::codex::refresh_codex_material,
            commands::codex::reveal_codex_material_source,
            commands::codex::import_codex_materials,
            commands::codex::remove_codex_material,
            commands::codex::list_codex_artifacts,
            commands::codex::open_codex_artifact,
            commands::codex::reveal_codex_artifact,
            commands::codex::export_codex_artifact,
            commands::codex::start_codex_turn,
            commands::codex::interrupt_codex_turn,
            commands::codex::resolve_codex_approval,
            commands::codex_artifacts::upload_codex_artifact,
            commands::codex_artifacts::list_codex_artifact_uploads,
            commands::codex_handoff::prepare_codex_handoff,
            commands::codex_handoff::commit_codex_handoff,
            commands::codex_handoff::list_pending_codex_handoffs,
            commands::codex_handoff::dismiss_codex_handoff_item,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::test_service_connection,
            commands::settings::get_ntfs_indexer_status,
            commands::settings::list_scan_rules,
            commands::settings::save_scan_rules,
            commands::today::get_today_snapshot,
            commands::today::get_recent_snapshot,
            commands::today::get_today_scan_status,
            commands::today::refresh_today,
            commands::today::query_today_workspace,
            commands::today::expand_today_workspace,
            commands::today::resolve_today_workspace_selection,
            commands::today::open_today_workspace_directory,
            commands::today::reveal_in_explorer,
            commands::today::open_file,
            commands::today::open_file_in_text_editor,
            commands::today::copy_file_to_clipboard,
            commands::today::delete_file,
            commands::today::exclude_file_directory,
            commands::value::evaluate_today_files,
            commands::value::evaluate_workspace_query,
            commands::value::get_jev_value_policy,
            commands::value::save_jev_value_policy,
            commands::knowledge::list_ragflow_chats,
            commands::knowledge::ask_ragflow_chat,
            commands::knowledge::list_ragflow_datasets,
            commands::knowledge::list_ragflow_agents,
            commands::knowledge::query_ragflow_knowledge,
            commands::knowledge::download_ragflow_document,
            commands::knowledge::upload_today_file,
            commands::summary::get_summary_settings,
            commands::summary::save_summary_settings,
            commands::summary::prepare_work_summary,
            commands::summary::generate_work_summary,
            commands::summary::save_summary_markdown,
            commands::summary::upload_summary_markdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
