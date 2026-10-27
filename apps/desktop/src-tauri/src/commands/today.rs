use serde::Serialize;
use tauri::State;

use crate::{
    app_state::AppState,
    scan::policy::ScanPolicy,
    system::explorer::{ExplorerLauncher, WindowsProcessLauncher},
};
use std::sync::Arc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayUnavailable {
    state: &'static str,
    remediation: String,
    files: Vec<()>,
    clusters: Vec<()>,
}

fn unavailable() -> TodayUnavailable {
    TodayUnavailable {
        state: "unavailable",
        remediation: "请先安装并启动 Everything；然后在设置中添加允许扫描的工作目录。".to_owned(),
        files: vec![],
        clusters: vec![],
    }
}

#[tauri::command]
pub fn get_today_snapshot(_state: State<'_, AppState>) -> TodayUnavailable {
    unavailable()
}

#[tauri::command]
pub fn refresh_today(_state: State<'_, AppState>) -> TodayUnavailable {
    unavailable()
}

#[tauri::command]
pub fn reveal_in_explorer(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    ExplorerLauncher::new(
        state.database.files(),
        ScanPolicy::new(vec![]),
        Arc::new(WindowsProcessLauncher),
    )
    .reveal(id)
    .map_err(|error| error.code().to_owned())
}
