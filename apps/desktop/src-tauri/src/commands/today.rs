use serde::Serialize;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

use crate::{
    app_state::AppState,
    discovery::selector::select_discovery_with_cli_path,
    scan::{
        file_stability::MetadataStability,
        policy::{AllowedRoot, ScanPolicy},
        service::ScanService,
    },
    system::explorer::{ExplorerLauncher, WindowsProcessLauncher},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayFile {
    id: i64,
    canonical_path: String,
    modified_at_utc_ms: i64,
    size_bytes: i64,
    source: String,
    status: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayCluster {
    label: String,
    file_ids: Vec<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayReady {
    state: &'static str,
    files: Vec<TodayFile>,
    clusters: Vec<TodayCluster>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayUnavailable {
    state: &'static str,
    remediation: String,
    files: Vec<TodayFile>,
    clusters: Vec<TodayCluster>,
}

fn unavailable(message: impl Into<String>) -> TodayUnavailable {
    TodayUnavailable {
        state: "unavailable",
        remediation: message.into(),
        files: vec![],
        clusters: vec![],
    }
}
type ActiveRules = (Vec<AllowedRoot>, Vec<PathBuf>, Option<PathBuf>);
fn rules(state: &AppState) -> Result<ActiveRules, TodayUnavailable> {
    let rules = state
        .scan_rules
        .get()
        .map_err(|_| unavailable("无法读取本地扫描规则。"))?;
    let exclusions = rules
        .custom_exclusions
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let policy = ScanPolicy::new(exclusions.clone());
    let roots = rules
        .allowed_roots
        .into_iter()
        .map(PathBuf::from)
        .map(|root| policy.validate_root(&root))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| unavailable("扫描目录无效，请在设置中重新保存。"))?;
    if roots.is_empty() {
        return Err(unavailable("请先在设置中添加允许扫描的工作目录。"));
    }
    Ok((roots, exclusions, rules.es_cli_path.map(PathBuf::from)))
}
fn bounds() -> (i64, i64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let start = now / 86_400_000 * 86_400_000;
    (start, start + 86_400_000)
}
fn refresh(state: &AppState) -> Result<TodayReady, TodayUnavailable> {
    let (roots, exclusions, cli_path) = rules(state)?;
    let discovery = select_discovery_with_cli_path(false, cli_path);
    if !discovery.health().available {
        return Err(unavailable(discovery.health().remediation));
    }
    let (start, end) = bounds();
    let snapshot = ScanService::new(
        Arc::from(discovery),
        ScanPolicy::for_roots(exclusions, roots.clone()),
        state.database.files(),
        Arc::new(MetadataStability),
    )
    .refresh_for_range(roots, start, end)
    .map_err(|_| unavailable("刷新未完成，请检查 Everything 是否运行以及目录权限。"))?;
    Ok(TodayReady {
        state: "ready",
        files: snapshot
            .files
            .into_iter()
            .map(|file| TodayFile {
                id: file.id,
                canonical_path: file.canonical_path,
                modified_at_utc_ms: file.modified_at_utc_ms,
                size_bytes: file.size_bytes,
                source: file.source,
                status: "待分析",
            })
            .collect(),
        clusters: snapshot
            .clusters
            .into_iter()
            .map(|cluster| TodayCluster {
                label: cluster.label,
                file_ids: cluster.file_ids,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn get_today_snapshot(state: State<'_, AppState>) -> Result<TodayReady, TodayUnavailable> {
    refresh(&state)
}
#[tauri::command]
pub fn refresh_today(state: State<'_, AppState>) -> Result<TodayReady, TodayUnavailable> {
    refresh(&state)
}
#[tauri::command]
pub fn reveal_in_explorer(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let (roots, exclusions, _) = rules(&state).map_err(|value| value.remediation)?;
    ExplorerLauncher::new(
        state.database.files(),
        ScanPolicy::for_roots(exclusions, roots),
        Arc::new(WindowsProcessLauncher),
    )
    .reveal(id)
    .map_err(|error| error.code().to_owned())
}
