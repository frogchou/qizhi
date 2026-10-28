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
        file_filter::{FileCategory, FileTypeFilter},
        file_stability::MetadataStability,
        policy::{AllowedRoot, ScanPolicy},
        progress::TodayScanStatus,
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
type ActiveRules = (Vec<AllowedRoot>, Vec<PathBuf>, Vec<FileCategory>);
fn rules(state: &AppState) -> Result<ActiveRules, TodayUnavailable> {
    let rules = state
        .scan_rules
        .get()
        .map_err(|_| unavailable("无法读取本地扫描规则。"))?;
    let crate::scan::configuration::ScanRules {
        allowed_roots,
        custom_exclusions,
        file_categories,
        ..
    } = rules;
    let exclusions = custom_exclusions
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let policy = ScanPolicy::new(exclusions.clone());
    let roots = allowed_roots
        .into_iter()
        .map(PathBuf::from)
        .map(|root| policy.validate_root(&root))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| unavailable("扫描目录无效，请在设置中重新保存。"))?;
    if roots.is_empty() {
        return Err(unavailable("请先在设置中添加允许扫描的工作目录。"));
    }
    Ok((roots, exclusions, file_categories))
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
    if !state.today_scan_progress.start() {
        return Err(unavailable("已有今日扫描正在进行，请等待它完成。"));
    }
    state.logger.info("today-scan", "today file scan started");
    let result: Result<TodayReady, TodayUnavailable> = (|| {
        let (roots, exclusions, file_categories) = rules(state)?;
        let (start, end) = bounds();
        let snapshot = ScanService::new(
            today_discovery(
                exclusions.clone(),
                state.today_scan_progress.clone(),
                FileTypeFilter::new(file_categories),
            ),
            ScanPolicy::for_roots(exclusions, roots.clone()),
            state.database.files(),
            Arc::new(MetadataStability),
        )
        .refresh_for_range(roots, start, end)
        .map_err(|_| unavailable("刷新未完成，请检查扫描范围和文件访问权限。"))?;
        Ok(ready_from_files(snapshot.files))
    })();
    match &result {
        Ok(snapshot) => {
            state.today_scan_progress.complete();
            state.logger.info(
                "today-scan",
                &format!(
                    "today file scan completed with {} files",
                    snapshot.files.len()
                ),
            );
        }
        Err(error) => {
            state.today_scan_progress.fail(&error.remediation);
            state.logger.error(
                "today-scan",
                &format!("today file scan failed: {}", error.remediation),
            );
        }
    }
    result
}

fn cached_snapshot_for_range(
    files: FileRepository,
    start_utc_ms: i64,
    end_utc_ms: i64,
    file_filter: &FileTypeFilter,
    policy: &ScanPolicy,
) -> Result<TodayReady, AppError> {
    let files = files
        .list_for_local_day(LocalDayRange::new(start_utc_ms, end_utc_ms))?
        .into_iter()
        .filter(|file| file_filter.allows(std::path::Path::new(&file.canonical_path)))
        .filter(|file| policy.is_cached_path_allowed(std::path::Path::new(&file.canonical_path)))
        .collect();
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

fn today_discovery(
    exclusions: Vec<PathBuf>,
    progress: crate::scan::progress::TodayScanProgress,
    file_filter: FileTypeFilter,
) -> Arc<dyn FileDiscovery> {
    Arc::new(NativeFileDiscovery::with_progress(
        exclusions,
        progress,
        file_filter,
    ))
}

#[tauri::command]
pub async fn get_today_snapshot(
    state: State<'_, AppState>,
) -> Result<TodayReady, TodayUnavailable> {
    let (start, end) = bounds();
    let (roots, exclusions, file_categories) = rules(&state)?;
    let file_filter = FileTypeFilter::new(file_categories);
    let policy = ScanPolicy::for_roots(exclusions, roots);
    cached_snapshot_for_range(state.database.files(), start, end, &file_filter, &policy)
        .map_err(|_| unavailable("无法读取已发现的今日文件。"))
}
#[tauri::command]
pub fn get_today_scan_status(state: State<'_, AppState>) -> TodayScanStatus {
    state.today_scan_progress.snapshot()
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
    launcher(&state)?
        .reveal(id)
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn open_file(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    launcher(&state)?
        .open(id)
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn open_file_in_text_editor(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    launcher(&state)?
        .open_in_text_editor(id)
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn copy_file_to_clipboard(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    launcher(&state)?
        .copy_to_clipboard(id)
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    launcher(&state)?
        .delete(id)
        .map_err(|error| error.code().to_owned())
}

fn launcher(state: &AppState) -> Result<ExplorerLauncher, String> {
    let (roots, exclusions, _) = rules(&state).map_err(|value| value.remediation)?;
    Ok(ExplorerLauncher::new(
        state.database.files(),
        ScanPolicy::for_roots(exclusions, roots),
        Arc::new(WindowsProcessLauncher),
    ))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use chrono::{Local, TimeZone, Timelike};

    use crate::{
        contracts::FileRecordInput,
        database::Database,
        scan::{file_filter::FileTypeFilter, policy::ScanPolicy},
    };

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
        assert_eq!(
            today_discovery(
                vec![],
                crate::scan::progress::TodayScanProgress::new(),
                FileTypeFilter::default(),
            )
            .name(),
            "native-file-system"
        );
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

        let snapshot = cached_snapshot_for_range(
            database.files(),
            start,
            end,
            &FileTypeFilter::default(),
            &ScanPolicy::new(vec![]),
        )
        .expect("read persisted snapshot");

        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].canonical_path, r"D:\\work\\today.txt");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cached_snapshot_hides_binary_files_saved_before_a_type_rule_change() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("qizhi-today-filter-{nonce}.sqlite"));
        let database = Database::open(&path).expect("database opens");
        let (start, end) = bounds();
        for (canonical_path, identity) in [
            (r"D:\\work\\old.o", "old-object"),
            (r"D:\\work\\notes.md", "notes"),
        ] {
            database
                .files()
                .upsert(&FileRecordInput {
                    canonical_path: canonical_path.to_owned(),
                    file_identity: identity.to_owned(),
                    modified_at_utc_ms: start + 1,
                    size_bytes: 12,
                    source: "本机文件".to_owned(),
                })
                .expect("persist today file");
        }

        let snapshot = cached_snapshot_for_range(
            database.files(),
            start,
            end,
            &FileTypeFilter::default(),
            &ScanPolicy::new(vec![]),
        )
        .expect("read persisted snapshot");

        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].canonical_path, r"D:\\work\\notes.md");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cached_snapshot_hides_records_inside_a_newly_excluded_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("qizhi-exclusion-{nonce}"));
        let excluded = root.join("private");
        std::fs::create_dir_all(&excluded).expect("create excluded directory");
        let file = excluded.join("notes.md");
        std::fs::write(&file, b"private notes").expect("write test file");
        let database = Database::open(std::path::Path::new(":memory:")).expect("database");
        let (start, end) = bounds();
        database
            .files()
            .upsert(&FileRecordInput {
                canonical_path: file.to_string_lossy().to_string(),
                file_identity: "private-notes".to_owned(),
                modified_at_utc_ms: start + 1,
                size_bytes: 13,
                source: "本机文件".to_owned(),
            })
            .expect("persist today file");

        let snapshot = cached_snapshot_for_range(
            database.files(),
            start,
            end,
            &FileTypeFilter::default(),
            &ScanPolicy::new(vec![excluded]),
        )
        .expect("read persisted snapshot");

        assert!(snapshot.files.is_empty());
        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_dir_all(root);
    }
}
