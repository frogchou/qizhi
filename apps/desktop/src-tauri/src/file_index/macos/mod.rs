use std::{
    collections::BTreeMap,
    fs::{self, Metadata},
    io::ErrorKind,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::{
    contracts::{FileRecordInput, LocalDayRange},
    scan::{
        configuration::{ScanRuleStore, ScanRules},
        policy::{MacPathAccess, ScanPolicy},
    },
};

mod events;
mod runtime;
mod search;
mod store;

pub use runtime::MacWorkspaceIndex;
pub use search::{FileSearchInput, FileSearchPage};

use super::IndexError;

const STORAGE_ERROR: &str = "无法读取或更新 Mac 本地文件索引。";
pub const MAC_INDEX_SOURCE: &str = "本机 Mac 文件索引";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[repr(i64)]
pub enum MacRootState {
    Building,
    Ready,
    Partial,
    Unavailable,
    Retrying,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacRootCoverage {
    pub path: String,
    pub state: MacRootState,
}

#[derive(Debug, Default)]
pub struct MacIndexSnapshot {
    pub records: Vec<FileRecordInput>,
    pub coverage: Vec<MacRootCoverage>,
}

#[derive(Debug)]
pub struct MacEvent {
    pub id: u64,
    pub path: PathBuf,
    pub observed_rename_ms: Option<i64>,
}

impl MacEvent {
    pub fn rename(id: u64, path: PathBuf, observed_rename_ms: Option<i64>) -> Self {
        Self {
            id,
            path,
            observed_rename_ms,
        }
    }
}

pub struct MacVolumeBatch<'a> {
    pub volume_id: &'a str,
    pub event_store_id: &'a str,
    pub device: u64,
    pub high_water_mark: u64,
    pub events: &'a [MacEvent],
    pub history_lost: bool,
}

#[derive(Clone)]
pub struct MacFileIndex {
    connection: Arc<Mutex<Connection>>,
    writer: Arc<Mutex<()>>,
}

impl MacFileIndex {
    pub fn open(data_dir: &Path) -> Result<Self, IndexError> {
        let connection = Connection::open(data_dir.join("mac-file-index.sqlite3"))
            .map_err(|_| storage_error())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA cache_size = -65536;",
            )
            .map_err(|_| storage_error())?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| storage_error())?;
        match version {
            0 => connection
                .execute_batch(include_str!("schema.sql"))
                .map_err(|_| storage_error())?,
            1 | 2 => {}
            _ => return Err(IndexError("Mac 文件索引由更新的栖知版本创建。".to_owned())),
        }
        if version < 2 {
            connection
                .execute_batch(include_str!("search-schema.sql"))
                .map_err(|_| storage_error())?;
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            writer: Arc::new(Mutex::new(())),
        })
    }

    pub fn configure(&self, rules: &ScanRules) -> Result<(), IndexError> {
        let encoded = serde_json::to_string(rules).map_err(|_| storage_error())?;
        let mut connection = self.connection.lock().map_err(|_| storage_error())?;
        let transaction = connection.transaction().map_err(|_| storage_error())?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT rules FROM index_configuration WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| storage_error())?;
        if previous.as_deref() == Some(&encoded) {
            return Ok(());
        }
        transaction.execute(
            "INSERT INTO index_configuration (singleton, generation, rules) VALUES (1, 1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET generation = generation + 1, rules = excluded.rules",
            [&encoded],
        ).map_err(|_| storage_error())?;
        transaction
            .execute(
                "DELETE FROM scan_roots WHERE NOT EXISTS (
                SELECT 1 FROM json_each(?1, '$.allowedRoots') WHERE value = scan_roots.path
            )",
                [&encoded],
            )
            .map_err(|_| storage_error())?;
        transaction
            .execute("UPDATE scan_roots SET state = 0", [])
            .map_err(|_| storage_error())?;
        for root in &rules.allowed_roots {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO scan_roots (path, state) VALUES (?1, 0)",
                    [root],
                )
                .map_err(|_| storage_error())?;
        }
        store::remove_orphans(&transaction)?;
        transaction.commit().map_err(|_| storage_error())
    }

    pub fn cursor(&self, volume_id: &str) -> Result<Option<u64>, IndexError> {
        let connection = self.connection.lock().map_err(|_| storage_error())?;
        store::cursor(&connection, volume_id, None)
    }

    pub fn reconcile(&self, batch: MacVolumeBatch<'_>) -> Result<(), IndexError> {
        self.reconcile_volume(batch, None, false)
    }

    fn reconcile_volume(
        &self,
        batch: MacVolumeBatch<'_>,
        monitored: Option<(&ScanRuleStore, i64, &[PathBuf])>,
        retry_partial_roots: bool,
    ) -> Result<(), IndexError> {
        let _writer = self.writer.lock().map_err(|_| storage_error())?;
        let (config, previous_cursor) = {
            let connection = self.connection.lock().map_err(|_| storage_error())?;
            (
                store::configuration(&connection)?,
                store::cursor(&connection, batch.volume_id, Some(batch.event_store_id))?,
            )
        };
        let Some(config) = config else {
            return Ok(());
        };
        if let Some((_, generation, _)) = monitored
            && generation != config.generation
        {
            return Err(IndexError(
                "扫描规则已变更，请按新范围更新索引。".to_owned(),
            ));
        }
        if batch.history_lost || previous_cursor.is_none() {
            let connection = self.connection.lock().map_err(|_| storage_error())?;
            store::mark_building(&connection, config.generation, batch.volume_id)?;
        }
        if !batch.history_lost
            && previous_cursor.is_some_and(|cursor| cursor > batch.high_water_mark)
        {
            return Err(IndexError(
                "文件变动位置已经更新，请重新获取变动。".to_owned(),
            ));
        }
        let policy = scan_policy(&config.rules);
        let device = batch.device.to_string();
        let mut updates = Vec::new();
        for root in &config.roots {
            let root_path = Path::new(&root.path);
            if monitored.is_some_and(|(_, _, roots)| !roots.iter().any(|path| path == root_path)) {
                continue;
            }
            if policy.macos_path_access(root_path) == MacPathAccess::Excluded {
                continue;
            }
            let live = root_metadata(root_path, &policy);
            if live
                .as_ref()
                .map(MetadataExt::dev)
                .is_some_and(|value| value != batch.device)
                || (live.is_none() && root.device.as_deref() != Some(&device))
            {
                continue;
            }
            let identity = live.as_ref().map(file_identity);
            let requires_scan = batch.history_lost
                || previous_cursor.is_none()
                || root.volume.as_deref() != Some(batch.volume_id)
                || root.identity != identity
                || (retry_partial_roots && root.state == MacRootState::Partial)
                || matches!(
                    root.state,
                    MacRootState::Building | MacRootState::Unavailable
                );
            let boundaries = if requires_scan {
                BTreeMap::from([(root_path.to_path_buf(), None)])
            } else {
                changed_boundaries(
                    root_path,
                    batch.events,
                    previous_cursor,
                    batch.high_water_mark,
                )
            };
            if !boundaries.is_empty() {
                let mut update = RootUpdate {
                    root: root.path.clone(),
                    identity,
                    boundaries: Vec::new(),
                };
                for (mut boundary, observed) in boundaries {
                    if live.is_none() {
                        update
                            .boundaries
                            .push(BoundaryUpdate::unavailable(boundary));
                        continue;
                    }
                    if policy.macos_path_access(&boundary) == MacPathAccess::Allowed
                        && let Ok(canonical) = fs::canonicalize(&boundary)
                        && canonical != boundary
                        && canonical.starts_with(root_path)
                    {
                        update.boundaries.push(BoundaryUpdate {
                            path: boundary,
                            files: vec![],
                            blocked: vec![],
                        });
                        boundary = canonical;
                    }
                    update.boundaries.push(scan_boundary(
                        &policy,
                        boundary,
                        batch.device,
                        batch.volume_id,
                        observed,
                    ));
                }
                // If a root changes identity during enumeration, hide the batch until the next scan.
                if root_metadata(root_path, &policy)
                    .as_ref()
                    .map(file_identity)
                    != update.identity
                {
                    update.identity = None;
                    update.boundaries = vec![BoundaryUpdate::unavailable(root_path.to_path_buf())];
                }
                updates.push(update);
            }
        }
        let commit = || {
            let mut connection = self.connection.lock().map_err(|_| storage_error())?;
            store::commit_batch(&mut connection, config.generation, batch, &updates)
        };
        if let Some((settings, _, _)) = monitored {
            settings
                .with_rules(|current| {
                    if *current != config.rules {
                        return Err(IndexError(
                            "扫描规则已变更，请按新范围更新索引。".to_owned(),
                        ));
                    }
                    commit()
                })
                .map_err(|_| storage_error())?
        } else {
            commit()
        }
    }

    fn configuration(&self) -> Result<Option<store::Configuration>, IndexError> {
        let connection = self.connection.lock().map_err(|_| storage_error())?;
        store::configuration(&connection)
    }

    fn roots_unavailable(&self, generation: i64, roots: &[PathBuf]) -> Result<(), IndexError> {
        let mut connection = self.connection.lock().map_err(|_| storage_error())?;
        store::mark_unavailable(&mut connection, generation, roots)
    }

    fn resume_cursor(&self, volume: &events::Volume) -> Result<Option<u64>, IndexError> {
        let connection = self.connection.lock().map_err(|_| storage_error())?;
        store::cursor(&connection, &volume.id, Some(&volume.event_store))
    }

    pub fn snapshot(&self, range: LocalDayRange) -> Result<MacIndexSnapshot, IndexError> {
        let (config, mut records) = {
            let connection = self.connection.lock().map_err(|_| storage_error())?;
            (
                store::configuration(&connection)?,
                store::records_in_range(&connection, range)?,
            )
        };
        let Some(config) = config else {
            return Ok(MacIndexSnapshot::default());
        };
        let generation = config.generation;
        let policy = scan_policy(&config.rules);
        let mut coverage = config
            .roots
            .into_iter()
            .filter_map(|root| {
                let path = Path::new(&root.path);
                if policy.macos_path_access(path) == MacPathAccess::Excluded {
                    return None;
                }
                let state = match root_metadata(path, &policy) {
                    None => MacRootState::Unavailable,
                    Some(metadata)
                        if root
                            .identity
                            .as_ref()
                            .is_some_and(|identity| *identity != file_identity(&metadata)) =>
                    {
                        MacRootState::Building
                    }
                    Some(_) => root.state,
                };
                Some(MacRootCoverage {
                    path: root.path,
                    state,
                })
            })
            .collect::<Vec<_>>();
        let mut readable_directories = BTreeMap::new();
        records.retain(|record| {
            let path = Path::new(&record.canonical_path);
            let access = policy.macos_path_access(path);
            if access == MacPathAccess::Excluded {
                return false;
            }
            if access == MacPathAccess::Allowed
                && !fs::symlink_metadata(path).is_ok_and(|metadata| {
                    metadata.is_file()
                        && record
                            .file_identity
                            .ends_with(&format!(":{}", inode_identity(&metadata)))
                })
            {
                return false;
            }
            let mut visible = false;
            for root in &mut coverage {
                if !matches!(root.state, MacRootState::Ready | MacRootState::Partial)
                    || !path.starts_with(&root.path)
                {
                    continue;
                }
                if access == MacPathAccess::Allowed
                    && can_list_parents(path, Path::new(&root.path), &mut readable_directories)
                {
                    visible = true;
                } else {
                    root.state = MacRootState::Partial;
                }
            }
            visible
        });
        let connection = self.connection.lock().map_err(|_| storage_error())?;
        store::check_generation(&connection, generation)?;
        Ok(MacIndexSnapshot { records, coverage })
    }
}

fn scan_policy(rules: &ScanRules) -> ScanPolicy {
    ScanPolicy::new(rules.custom_exclusions.iter().map(PathBuf::from).collect())
}

fn root_metadata(path: &Path, policy: &ScanPolicy) -> Option<Metadata> {
    if policy.macos_path_access(path) != MacPathAccess::Allowed
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || fs::read_dir(path).is_err() {
        return None;
    }
    Some(metadata)
}

pub(crate) fn can_list_parents(
    path: &Path,
    root: &Path,
    known: &mut BTreeMap<PathBuf, bool>,
) -> bool {
    if path == root {
        return true;
    }
    let mut parents = path
        .ancestors()
        .skip(1)
        .take_while(|path| path.starts_with(root))
        .collect::<Vec<_>>();
    while let Some(parent) = parents.pop() {
        if !*known
            .entry(parent.to_path_buf())
            .or_insert_with(|| fs::read_dir(parent).is_ok())
        {
            return false;
        }
    }
    true
}

struct RootUpdate {
    root: String,
    identity: Option<String>,
    boundaries: Vec<BoundaryUpdate>,
}

struct BoundaryUpdate {
    path: PathBuf,
    files: Vec<IndexedFile>,
    blocked: Vec<PathBuf>,
}

impl BoundaryUpdate {
    fn unavailable(path: PathBuf) -> Self {
        Self {
            blocked: vec![path.clone()],
            path,
            files: vec![],
        }
    }
}

struct IndexedFile {
    path: String,
    identity: String,
    created_ms: i64,
    modified_ms: i64,
    observed_ms: i64,
    size_bytes: i64,
}

fn changed_boundaries(
    root: &Path,
    events: &[MacEvent],
    from: Option<u64>,
    to: u64,
) -> BTreeMap<PathBuf, Option<i64>> {
    let mut changes = BTreeMap::new();
    for event in events {
        if from.is_some_and(|cursor| event.id <= cursor) || event.id > to {
            continue;
        }
        if event.path.starts_with(root) {
            let previous = changes.entry(event.path.clone()).or_insert(None);
            *previous = (*previous).max(event.observed_rename_ms);
        } else if root.starts_with(&event.path) {
            changes.entry(root.to_path_buf()).or_insert(None);
        }
    }
    changes
}

fn scan_boundary(
    policy: &ScanPolicy,
    boundary: PathBuf,
    device: u64,
    volume_id: &str,
    observed: Option<i64>,
) -> BoundaryUpdate {
    let mut update = BoundaryUpdate {
        path: boundary.clone(),
        files: vec![],
        blocked: vec![],
    };
    let mut queue = vec![boundary];
    while let Some(path) = queue.pop() {
        if path.to_str().is_none() {
            continue;
        }
        match policy.macos_path_access(&path) {
            MacPathAccess::Excluded => continue,
            MacPathAccess::Unavailable => {
                update.blocked.push(path);
                continue;
            }
            MacPathAccess::Allowed => {}
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.dev() == device => metadata,
            Ok(_) => continue,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => {
                update.blocked.push(path);
                continue;
            }
        };
        if metadata.is_dir() {
            let Ok(entries) = fs::read_dir(&path) else {
                update.blocked.push(path);
                continue;
            };
            for entry in entries {
                match entry {
                    Ok(entry) => queue.push(entry.path()),
                    Err(_) => {
                        update.blocked.push(path);
                        break;
                    }
                }
            }
        } else if metadata.is_file() {
            update.files.push(IndexedFile {
                identity: format!("mac:{volume_id}:{}", inode_identity(&metadata)),
                path: path.to_str().expect("UTF-8 path checked").to_owned(),
                created_ms: milliseconds(metadata.created()),
                modified_ms: milliseconds(metadata.modified()),
                observed_ms: observed.unwrap_or(0),
                size_bytes: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
            });
        }
    }
    update
}

fn file_identity(metadata: &Metadata) -> String {
    format!("{}:{}", metadata.dev(), inode_identity(metadata))
}

fn inode_identity(metadata: &Metadata) -> String {
    let created_ns = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    format!("{}:{created_ns}", metadata.ino())
}

pub(crate) fn matches_file_identity(path: &Path, expected: &str) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    matches_indexed_metadata(path, &metadata, expected)
}

pub(crate) fn matches_indexed_metadata(path: &Path, metadata: &Metadata, expected: &str) -> bool {
    if !metadata.is_file() {
        return false;
    }
    events::Volume::for_path(path, metadata.dev())
        .is_some_and(|volume| expected == format!("mac:{}:{}", volume.id, inode_identity(metadata)))
}

fn milliseconds(time: std::io::Result<SystemTime>) -> i64 {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn storage_error() -> IndexError {
    IndexError(STORAGE_ERROR.to_owned())
}
