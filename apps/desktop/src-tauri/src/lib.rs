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
            app.manage(app_state::AppState { database });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::test_service_connection,
            commands::settings::get_everything_status,
            commands::today::get_today_snapshot,
            commands::today::refresh_today,
            commands::today::reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
