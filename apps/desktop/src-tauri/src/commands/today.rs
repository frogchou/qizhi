use chrono::{Datelike, Local, TimeZone};
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tauri::State;

use crate::{
    app_state::AppState,
    contracts::{FileRecord, LocalDayRange},
    database::{AppError, repositories::FileRepository},
    discovery::{native_fs::NativeFileDiscovery, port::FileDiscovery},
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
type ActiveRules = (Vec<AllowedRoot>, Vec<PathBuf>);
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
    Ok((roots, exclusions))
}
fn bounds() -> (i64, i64) {
    let now = Local::now();
    let today = now.date_naive();
    let start = Local
        .with_ymd_and_hms(today.year(), today.month(), today.day(), 0, 0, 0)
        .earliest()
        .expect("local midnight is representable");
    let tomorrow = today.succ_opt().expect("tomorrow is representable");
    let end = Local
        .with_ymd_and_hms(tomorrow.year(), tomorrow.month(), tomorrow.day(), 0, 0, 0)
        .earliest()
        .expect("next local midnight is representable");
    (start.timestamp_millis(), end.timestamp_millis())
}
fn refresh(state: &AppState) -> Result<TodayReady, TodayUnavailable> {
    let (roots, exclusions) = rules(state)?;
    let (start, end) = bounds();
    let snapshot = ScanService::new(
        today_discovery(exclusions.clone()),
        ScanPolicy::for_roots(exclusions, roots.clone()),
        state.database.files(),
        Arc::new(MetadataStability),
    )
    .refresh_for_range(roots, start, end)
    .map_err(|_| unavailable("刷新未完成，请检查扫描范围和文件访问权限。"))?;
    Ok(ready_from_files(snapshot.files))
}

fn cached_snapshot_for_range(
    files: FileRepository,
    start_utc_ms: i64,
    end_utc_ms: i64,
) -> Result<TodayReady, AppError> {
    let files = files.list_for_local_day(LocalDayRange::new(start_utc_ms, end_utc_ms))?;
    Ok(ready_from_files(files))
}

fn ready_from_files(files: Vec<FileRecord>) -> TodayReady {
    let mut groups = BTreeMap::<String, Vec<i64>>::new();
    for file in &files {
        groups.entry(file.source.clone()).or_default().push(file.id);
    }
    TodayReady {
        state: "ready",
        files: files
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
        clusters: groups
            .into_iter()
            .map(|(label, file_ids)| TodayCluster { label, file_ids })
            .collect(),
    }
}

fn today_discovery(exclusions: Vec<PathBuf>) -> Arc<dyn FileDiscovery> {
    Arc::new(NativeFileDiscovery::new(exclusions))
}

#[tauri::command]
pub async fn get_today_snapshot(
    state: State<'_, AppState>,
) -> Result<TodayReady, TodayUnavailable> {
    let (start, end) = bounds();
    cached_snapshot_for_range(state.database.files(), start, end)
        .map_err(|_| unavailable("无法读取已发现的今日文件。"))
}
#[tauri::command]
pub async fn refresh_today(state: State<'_, AppState>) -> Result<TodayReady, TodayUnavailable> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&state))
        .await
        .map_err(|_| unavailable("刷新今日文件时发生意外错误。"))?
}
#[tauri::command]
pub fn reveal_in_explorer(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let (roots, exclusions) = rules(&state).map_err(|value| value.remediation)?;
    ExplorerLauncher::new(
        state.database.files(),
        ScanPolicy::for_roots(exclusions, roots),
        Arc::new(WindowsProcessLauncher),
    )
    .reveal(id)
    .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use chrono::{Local, TimeZone, Timelike};

    use crate::{contracts::FileRecordInput, database::Database};

    use super::{bounds, cached_snapshot_for_range, today_discovery};

    #[test]
    fn uses_local_calendar_midnights_for_today() {
        let (start, end) = bounds();
        let start = Local
            .timestamp_millis_opt(start)
            .single()
            .expect("valid local start");
        let end = Local
            .timestamp_millis_opt(end)
            .single()
            .expect("valid local end");
        assert_eq!((start.hour(), start.minute(), start.second()), (0, 0, 0));
        assert_eq!((end.hour(), end.minute(), end.second()), (0, 0, 0));
        assert!(end > start);
    }

    #[test]
    fn uses_native_discovery_without_an_everything_connection() {
        assert_eq!(today_discovery(vec![]).name(), "native-file-system");
    }

    #[test]
    fn cached_snapshot_returns_persisted_today_records_without_discovery() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("qizhi-today-cache-{nonce}.sqlite"));
        let database = Database::open(&path).expect("database opens");
        let (start, end) = bounds();
        database
            .files()
            .upsert(&FileRecordInput {
                canonical_path: r"D:\\work\\today.txt".to_owned(),
                file_identity: "today-file".to_owned(),
                modified_at_utc_ms: start + 1,
                size_bytes: 12,
                source: "本机文件".to_owned(),
            })
            .expect("persist today file");

        let snapshot = cached_snapshot_for_range(database.files(), start, end)
            .expect("read persisted snapshot");

        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].canonical_path, r"D:\\work\\today.txt");
        let _ = std::fs::remove_file(path);
    }
}
