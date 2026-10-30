use chrono::{Datelike, Local, TimeZone};
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use tauri::State;

use crate::{
    app_state::AppState,
    contracts::{FileRecord, FileRecordInput, LocalDayRange},
    database::{AppError, repositories::FileRepository},
    ntfs::{
        ipc::{INDEXER_PROTOCOL_VERSION, IndexerRequest, IndexerRequestKind},
        pipe::call_indexer_service,
    },
    scan::{
        configuration::ScanRules,
        file_filter::{FileCategory, FileTypeFilter},
        policy::{AllowedRoot, ScanPolicy, display_path},
        progress::TodayScanStatus,
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

fn exclude_parent_from_rules(mut rules: ScanRules, file: &FileRecord) -> Result<ScanRules, String> {
    let parent = std::path::Path::new(&file.canonical_path)
        .parent()
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "无法识别该文件所在目录。".to_owned())?;
    let parent = display_path(parent);
    if !rules
        .custom_exclusions
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&parent))
    {
        rules.custom_exclusions.push(parent);
    }
    Ok(rules)
}

fn configure_indexer_after_rule_change(state: &AppState, rules: &ScanRules) {
    let request = IndexerRequest {
        protocol_version: INDEXER_PROTOCOL_VERSION,
        request_id: format!(
            "today-exclude-configure-{}",
            chrono::Utc::now().timestamp_millis()
        ),
        kind: IndexerRequestKind::Configure {
            allowed_roots: rules.allowed_roots.clone(),
            excluded_roots: rules.custom_exclusions.clone(),
            file_categories: rules.file_categories.clone(),
        },
    };
    match call_indexer_service(&request) {
        Ok(response) if response.status == "ready" => state.logger.info(
            "today-index",
            "directory exclusion synchronized to local NTFS indexer",
        ),
        Ok(response) => state.logger.error(
            "today-index",
            &format!(
                "directory exclusion saved locally but indexer synchronization failed: {}",
                response
                    .message
                    .unwrap_or_else(|| "local indexer rejected configuration".to_owned())
            ),
        ),
        Err(error) => state.logger.error(
            "today-index",
            &format!(
                "directory exclusion saved locally but indexer synchronization failed: {error}"
            ),
        ),
    }
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
    state
        .logger
        .info("today-index", "today NTFS index synchronization started");
    let result: Result<TodayReady, TodayUnavailable> = (|| {
        let (roots, exclusions, file_categories) = rules(state)?;
        let (start, end) = bounds();
        let configure = IndexerRequest {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: format!("today-configure-{}", chrono::Utc::now().timestamp_millis()),
            kind: IndexerRequestKind::Configure {
                allowed_roots: roots
                    .iter()
                    .map(|root| crate::scan::policy::display_path(&root.0))
                    .collect(),
                excluded_roots: exclusions
                    .iter()
                    .map(|path| crate::scan::policy::display_path(path))
                    .collect(),
                file_categories: file_categories.clone(),
            },
        };
        ensure_ready_response(call_indexer_service(&configure))?;
        let sync = IndexerRequest {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: format!("today-sync-{}", chrono::Utc::now().timestamp_millis()),
            kind: IndexerRequestKind::Sync,
        };
        ensure_accepted_response(call_indexer_service(&sync))?;
        let query = IndexerRequest {
            protocol_version: INDEXER_PROTOCOL_VERSION,
            request_id: format!("today-list-{}", chrono::Utc::now().timestamp_millis()),
            kind: IndexerRequestKind::ListToday {
                start_utc_ms: start,
                end_utc_ms: end,
            },
        };
        let response = call_indexer_service(&query).map_err(unavailable)?;
        if response.status != "ready" {
            return Err(unavailable(response.message.unwrap_or_else(|| {
                "本地 NTFS 索引服务无法返回今日文件。".to_owned()
            })));
        }
        let records = response
            .candidates
            .into_iter()
            .map(|candidate| FileRecordInput {
                canonical_path: candidate.canonical_path,
                file_identity: candidate.file_reference_number,
                modified_at_utc_ms: candidate.modified_at_utc_ms,
                size_bytes: candidate.size_bytes.unwrap_or_default(),
                source: "本机 NTFS 索引".to_owned(),
            })
            .collect::<Vec<_>>();
        state
            .database
            .files()
            .replace_indexed_for_local_day(LocalDayRange::new(start, end), &records)
            .map_err(|_| unavailable("无法保存本地 NTFS 索引结果。"))?;
        cached_snapshot_for_range(
            state.database.files(),
            start,
            end,
            &FileTypeFilter::new(file_categories),
            &ScanPolicy::for_roots(exclusions, roots),
        )
        .map_err(|_| unavailable("无法读取本地 NTFS 索引结果。"))
    })();
    match &result {
        Ok(snapshot) => {
            state.today_scan_progress.complete();
            state.logger.info(
                "today-index",
                &format!(
                    "today NTFS index synchronization completed with {} files",
                    snapshot.files.len()
                ),
            );
        }
        Err(error) => {
            state.today_scan_progress.fail(&error.remediation);
            state.logger.error(
                "today-index",
                &format!(
                    "today NTFS index synchronization failed: {}",
                    error.remediation
                ),
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
        // `本机文件` identifies the retired recursive scanner. Do not surface
        // its stale cache as if it were produced by the NTFS indexer.
        .filter(|file| file.source != "本机文件")
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

fn ensure_ready_response(
    response: Result<crate::ntfs::ipc::IndexerResponse, String>,
) -> Result<(), TodayUnavailable> {
    match response {
        Ok(response) if response.status == "ready" => Ok(()),
        Ok(response) => {
            Err(unavailable(response.message.unwrap_or_else(|| {
                "本地 NTFS 索引服务拒绝了扫描范围。".to_owned()
            })))
        }
        Err(message) => Err(unavailable(message)),
    }
}

fn ensure_accepted_response(
    response: Result<crate::ntfs::ipc::IndexerResponse, String>,
) -> Result<(), TodayUnavailable> {
    match response {
        Ok(response) if response.status == "accepted" || response.status == "ready" => Ok(()),
        Ok(response) => {
            Err(unavailable(response.message.unwrap_or_else(|| {
                "本地 NTFS 索引服务无法启动同步。".to_owned()
            })))
        }
        Err(message) => Err(unavailable(message)),
    }
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

#[tauri::command]
pub async fn exclude_file_directory(
    state: State<'_, AppState>,
    id: i64,
) -> Result<TodayReady, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let file = state
            .database
            .files()
            .get_by_id(id)
            .map_err(|_| "无法读取所选文件。".to_owned())?
            .ok_or_else(|| "所选文件已不在今日列表中。".to_owned())?;
        let (roots, exclusions, _) = rules(&state).map_err(|error| error.remediation)?;
        if !ScanPolicy::for_roots(exclusions, roots)
            .is_cached_path_allowed(std::path::Path::new(&file.canonical_path))
        {
            return Err("该文件已不在允许扫描范围内，无法更新屏蔽目录。".to_owned());
        }
        let saved = state
            .scan_rules
            .get()
            .map_err(|_| "无法读取扫描规则。".to_owned())
            .and_then(|rules| exclude_parent_from_rules(rules, &file))
            .and_then(|rules| {
                state
                    .scan_rules
                    .save(rules)
                    .map_err(|_| "无法保存屏蔽目录。".to_owned())
            })?;
        configure_indexer_after_rule_change(&state, &saved);
        let (start, end) = bounds();
        let exclusions = saved
            .custom_exclusions
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let validation_policy = ScanPolicy::new(exclusions.clone());
        let roots = saved
            .allowed_roots
            .iter()
            .map(PathBuf::from)
            .map(|root| validation_policy.validate_root(&root))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "保存的扫描目录无效，请在设置中重新保存。".to_owned())?;
        cached_snapshot_for_range(
            state.database.files(),
            start,
            end,
            &FileTypeFilter::new(saved.file_categories),
            &ScanPolicy::for_roots(exclusions, roots),
        )
        .map_err(|_| "屏蔽目录后无法刷新今日列表。".to_owned())
    })
    .await
    .map_err(|_| "屏蔽目录时发生意外错误。".to_owned())?
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
        contracts::{FileRecord, FileRecordInput},
        database::Database,
        scan::{configuration::ScanRules, file_filter::FileTypeFilter, policy::ScanPolicy},
    };

    use super::{bounds, cached_snapshot_for_range, exclude_parent_from_rules};

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
                source: "本机 NTFS 索引".to_owned(),
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
                    source: "本机 NTFS 索引".to_owned(),
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
    fn cached_snapshot_hides_legacy_recursive_scan_records() {
        let database = Database::open(std::path::Path::new(":memory:")).expect("database");
        let (start, end) = bounds();
        let repository = database.files();
        for (path, identity, source) in [
            (r"D:\\work\\legacy.md", "legacy", "本机文件"),
            (r"D:\\work\\indexed.md", "indexed", "本机 NTFS 索引"),
        ] {
            repository
                .upsert(&FileRecordInput {
                    canonical_path: path.to_owned(),
                    file_identity: identity.to_owned(),
                    modified_at_utc_ms: start + 1,
                    size_bytes: 12,
                    source: source.to_owned(),
                })
                .expect("persist cached record");
        }

        let snapshot = cached_snapshot_for_range(
            repository,
            start,
            end,
            &FileTypeFilter::default(),
            &ScanPolicy::new(vec![]),
        )
        .expect("read persisted snapshot");

        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].canonical_path, r"D:\\work\\indexed.md");
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

    #[test]
    fn excludes_the_selected_file_parent_from_the_cached_today_snapshot() {
        let database = Database::open(std::path::Path::new(":memory:")).expect("database");
        let (start, end) = bounds();
        let repository = database.files();
        for (canonical_path, identity) in [
            (r"D:\work\private\notes.md".to_owned(), "private-notes"),
            (r"D:\work\shared\plan.md".to_owned(), "shared-plan"),
        ] {
            repository
                .upsert(&FileRecordInput {
                    canonical_path,
                    file_identity: identity.to_owned(),
                    modified_at_utc_ms: start + 1,
                    size_bytes: 12,
                    source: "本机 NTFS 索引".to_owned(),
                })
                .expect("persist today file");
        }
        let selected = repository
            .get_by_identity(r"D:\work\private\notes.md", "private-notes")
            .expect("read selected file")
            .expect("selected file exists");
        let rules = exclude_parent_from_rules(
            ScanRules {
                allowed_roots: vec![r"D:\work".to_owned()],
                custom_exclusions: vec![],
                file_categories: vec![],
            },
            &FileRecord {
                id: selected.id,
                canonical_path: selected.canonical_path,
                file_identity: selected.file_identity,
                modified_at_utc_ms: selected.modified_at_utc_ms,
                size_bytes: selected.size_bytes,
                source: selected.source,
            },
        )
        .expect("selected parent is excluded");
        let snapshot = cached_snapshot_for_range(
            repository,
            start,
            end,
            &FileTypeFilter::default(),
            &ScanPolicy::new(
                rules
                    .custom_exclusions
                    .iter()
                    .map(std::path::PathBuf::from)
                    .collect(),
            ),
        )
        .expect("filtered cached snapshot");

        assert_eq!(rules.custom_exclusions, vec![r"D:\work\private"]);
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].canonical_path, r"D:\work\shared\plan.md");
    }

    #[test]
    fn replacing_today_index_results_removes_legacy_scan_records_only() {
        let database = Database::open(std::path::Path::new(":memory:")).expect("database");
        let (start, end) = bounds();
        let repository = database.files();
        for (path, identity, source) in [
            (r"D:\\work\\legacy.md", "legacy", "本机文件"),
            (r"D:\\work\\history.md", "history", "浏览历史"),
        ] {
            repository
                .upsert(&FileRecordInput {
                    canonical_path: path.to_owned(),
                    file_identity: identity.to_owned(),
                    modified_at_utc_ms: start + 1,
                    size_bytes: 12,
                    source: source.to_owned(),
                })
                .expect("persist cached record");
        }

        repository
            .replace_indexed_for_local_day(
                crate::contracts::LocalDayRange::new(start, end),
                &[FileRecordInput {
                    canonical_path: r"D:\\work\\indexed.docx".to_owned(),
                    file_identity: "ntfs:42".to_owned(),
                    modified_at_utc_ms: start + 2,
                    size_bytes: 24,
                    source: "本机 NTFS 索引".to_owned(),
                }],
            )
            .expect("replace local index records");

        let records = repository
            .list_for_local_day(crate::contracts::LocalDayRange::new(start, end))
            .expect("read records");
        assert_eq!(records.len(), 2);
        assert!(
            records
                .iter()
                .any(|record| record.canonical_path == r"D:\\work\\indexed.docx")
        );
        assert!(
            records
                .iter()
                .any(|record| record.canonical_path == r"D:\\work\\history.md")
        );
        assert!(
            !records
                .iter()
                .any(|record| record.canonical_path == r"D:\\work\\legacy.md")
        );
    }
}
