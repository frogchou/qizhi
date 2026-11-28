use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSearchAction {
    Open,
    Reveal,
    Copy,
    AddToBasket,
}

#[cfg(target_os = "macos")]
use {
    crate::{
        app_state::AppState,
        basket::Basket,
        file_index::macos::{FileSearchInput, FileSearchPage},
        scan::policy::{ScanPolicy, live_scan_roots},
        system::explorer::{
            FileAction, ProcessLauncher, SystemProcessLauncher, file_command,
            set_file_drop_clipboard,
        },
    },
    std::path::{Path, PathBuf},
    tauri::State,
};

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn search_local_files(
    state: State<'_, AppState>,
    input: FileSearchInput,
) -> Result<FileSearchPage, String> {
    let index = state.file_index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        index.search(input).map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "本机查找未完成，请重试。".to_owned())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn search_local_files() -> Result<(), String> {
    Err("此设备暂不支持快速查找。".to_owned())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn act_on_search_result(
    state: State<'_, AppState>,
    basket: State<'_, Basket>,
    record_key: String,
    action: FileSearchAction,
) -> Result<(), String> {
    let state = state.inner().clone();
    let basket = basket.inner().clone();
    tauri::async_runtime::spawn_blocking(move || act_on_file(&state, &basket, &record_key, action))
        .await
        .map_err(|_| "文件操作未完成，请重试。".to_owned())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn act_on_search_result(_action: FileSearchAction) -> Result<(), String> {
    Err("此设备暂不支持快速查找。".to_owned())
}

#[cfg(target_os = "macos")]
fn act_on_file(
    state: &AppState,
    basket: &Basket,
    key: &str,
    action: FileSearchAction,
) -> Result<(), String> {
    let record = state
        .file_index
        .resolve_search_record(key)
        .map_err(|error| error.to_string())?;
    let path = Path::new(&record.canonical_path);
    let stale = "文件已移动、变更或无法访问，请重新查找。";
    let snapshot = state
        .scan_rules
        .with_rules(|rules| {
            let exclusions = rules
                .custom_exclusions
                .iter()
                .map(PathBuf::from)
                .collect::<Vec<_>>();
            let roots = live_scan_roots(&rules.allowed_roots, &exclusions).map_err(|_| stale)?;
            let policy = ScanPolicy::for_roots(exclusions, roots);
            if matches!(action, FileSearchAction::AddToBasket) {
                return policy
                    .open_verified_file(path, Some(&record.file_identity))
                    .map(Some)
                    .map_err(|_| stale);
            }
            if !policy.is_allowed_indexed_path(path, &record.file_identity) {
                return Err(stale);
            }
            let result = match action {
                FileSearchAction::Copy => set_file_drop_clipboard(path),
                FileSearchAction::Open | FileSearchAction::Reveal => {
                    let mode = if matches!(action, FileSearchAction::Open) {
                        FileAction::Open
                    } else {
                        FileAction::Reveal
                    };
                    let (program, arguments) = file_command(mode, path);
                    SystemProcessLauncher.launch(program, &arguments)
                }
                FileSearchAction::AddToBasket => unreachable!(),
            };
            result
                .map(|_| None)
                .map_err(|_| "系统未能完成该文件操作，请重试。")
        })
        .map_err(|_| "无法读取扫描规则，请重试。")??;
    if let Some(file) = snapshot {
        basket.local_snapshot("local", "快速查找", path, file)?;
    }
    Ok(())
}
