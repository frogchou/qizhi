pub mod app_state;
pub mod commands;
pub mod config;
pub mod contracts;
pub mod database;
pub mod discovery;
pub mod scan;
pub mod system;
pub mod telemetry;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            let everything_sdk_path = app
                .path()
                .resource_dir()
                .expect("resource directory")
                .join("Everything64.dll");
            app.manage(app_state::AppState {
                database,
                scan_rules,
                everything_sdk_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::test_service_connection,
            commands::settings::pick_folder,
            commands::settings::get_everything_status,
            commands::settings::list_scan_rules,
            commands::settings::save_scan_rules,
            commands::today::get_today_snapshot,
            commands::today::refresh_today,
            commands::today::reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
