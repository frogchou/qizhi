use std::{
    collections::BTreeMap,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use crate::{
    contracts::LocalDayRange,
    scan::{
        configuration::{ScanRuleStore, ScanRules},
        policy::MacPathAccess,
    },
};

use super::{
    FileSearchInput, FileSearchPage, IndexError, MacEvent, MacFileIndex, MacIndexSnapshot,
    MacRootCoverage, MacRootState, MacVolumeBatch,
    events::{Volume, Watcher, current_event_id},
    root_metadata, scan_policy,
};
use crate::file_index::IndexStatus;

const REFRESH_WAIT: Duration = Duration::from_millis(750);
const WATCHER_INTERVAL: Duration = Duration::from_millis(400);
const NOT_AVAILABLE: &str = "Mac 本地文件索引暂不可用，请检查数据目录后重试。";

#[derive(Clone, Default)]
pub struct MacWorkspaceIndex {
    active: Option<Arc<Runtime>>,
    startup_error: Option<String>,
}

struct Runtime {
    index: MacFileIndex,
    settings: ScanRuleStore,
    tasks: SyncSender<WorkerSignal>,
    worker: Option<JoinHandle<()>>,
    diagnostic: Arc<Mutex<Result<Vec<PathBuf>, String>>>,
}

enum WorkerSignal {
    Changed,
    Refresh(SyncSender<()>),
    Stop,
}

impl MacWorkspaceIndex {
    pub fn open(data_dir: &Path, settings: ScanRuleStore) -> Self {
        match Self::start(data_dir, settings) {
            Ok(active) => Self {
                active: Some(Arc::new(active)),
                startup_error: None,
            },
            Err(error) => Self {
                active: None,
                startup_error: Some(error.to_string()),
            },
        }
    }

    fn start(data_dir: &Path, settings: ScanRuleStore) -> Result<Runtime, IndexError> {
        let index = MacFileIndex::open(data_dir)?;
        sync_settings(&index, &settings)?;
        let (tasks, receiver) = mpsc::sync_channel(1);
        let diagnostic = Arc::new(Mutex::new(Ok(Vec::new())));
        let worker_diagnostic = diagnostic.clone();
        let worker_index = index.clone();
        let worker_settings = settings.clone();
        let worker = thread::Builder::new()
            .name("qizhi-mac-file-index".to_owned())
            .spawn(move || run_worker(worker_index, worker_settings, receiver, worker_diagnostic))
            .map_err(|_| IndexError(NOT_AVAILABLE.to_owned()))?;
        Ok(Runtime {
            index,
            settings,
            tasks,
            worker: Some(worker),
            diagnostic,
        })
    }

    fn active(&self) -> Result<&Runtime, IndexError> {
        self.active.as_deref().ok_or_else(|| {
            IndexError(
                self.startup_error
                    .as_deref()
                    .unwrap_or(NOT_AVAILABLE)
                    .to_owned(),
            )
        })
    }

    pub fn configure(&self, _: &ScanRules) -> Result<(), IndexError> {
        let active = self.active()?;
        sync_settings(&active.index, &active.settings)?;
        self.recheck();
        Ok(())
    }

    pub fn recheck(&self) {
        if let Some(active) = &self.active {
            let _ = active.tasks.try_send(WorkerSignal::Changed);
        }
    }

    pub fn search(&self, input: FileSearchInput) -> Result<FileSearchPage, IndexError> {
        let active = self.active()?;
        let rules = sync_settings(&active.index, &active.settings)?;
        let mut page = active.index.search(input)?;
        if read_settings(&active.settings)? != rules {
            return Err(IndexError("扫描规则已变更，请重新查找。".to_owned()));
        }
        apply_diagnostics(active, &mut page.coverage)?;
        Ok(page)
    }

    pub fn resolve_search_record(
        &self,
        key: &str,
    ) -> Result<crate::contracts::FileRecordInput, IndexError> {
        let active = self.active()?;
        let rules = sync_settings(&active.index, &active.settings)?;
        let result = active.index.resolve_search_record(key)?;
        if read_settings(&active.settings)? != rules {
            return Err(IndexError("扫描规则已变更，请重新查找。".to_owned()));
        }
        Ok(result)
    }

    pub fn status(&self) -> IndexStatus {
        match self.snapshot(LocalDayRange::new(0, 0), false) {
            Ok(snapshot) => {
                let ready = snapshot
                    .coverage
                    .iter()
                    .any(|root| matches!(root.state, MacRootState::Ready | MacRootState::Partial));
                let message = if snapshot.coverage.is_empty() {
                    "请在设置中添加允许扫描的本机工作文件夹。"
                } else if snapshot
                    .coverage
                    .iter()
                    .all(|root| root.state == MacRootState::Ready)
                {
                    "Mac 本地文件索引已就绪。"
                } else if ready {
                    "部分工作文件夹正在更新或无法访问。"
                } else if snapshot
                    .coverage
                    .iter()
                    .any(|root| root.state == MacRootState::Retrying)
                {
                    "Mac 本地文件索引更新未完成，后台正在重试。"
                } else if snapshot
                    .coverage
                    .iter()
                    .any(|root| root.state == MacRootState::Building)
                {
                    "正在建立 Mac 本地文件索引。"
                } else {
                    "无法扫描已选目录，请检查文件访问权限或选择本机 APFS 工作文件夹。"
                };
                IndexStatus {
                    available: ready,
                    message: message.to_owned(),
                }
            }
            Err(error) => IndexStatus {
                available: false,
                message: error.to_string(),
            },
        }
    }

    pub fn snapshot(
        &self,
        range: LocalDayRange,
        flush: bool,
    ) -> Result<MacIndexSnapshot, IndexError> {
        let active = self.active()?;
        let rules = sync_settings(&active.index, &active.settings)?;
        if flush {
            let (response, completion) = mpsc::sync_channel(1);
            if active
                .tasks
                .try_send(WorkerSignal::Refresh(response))
                .is_ok()
            {
                let _ = completion.recv_timeout(REFRESH_WAIT);
            }
        }
        let mut snapshot = active.index.snapshot(range)?;
        if read_settings(&active.settings)? != rules {
            return Err(IndexError("扫描规则已变更，请刷新文件列表。".to_owned()));
        }
        apply_diagnostics(active, &mut snapshot.coverage)?;
        Ok(snapshot)
    }
}

fn apply_diagnostics(active: &Runtime, coverage: &mut [MacRootCoverage]) -> Result<(), IndexError> {
    let diagnostic = active
        .diagnostic
        .lock()
        .map_err(|_| IndexError(NOT_AVAILABLE.to_owned()))?;
    let failed = diagnostic
        .as_ref()
        .map_err(|error| IndexError(error.clone()))?;
    for root in coverage {
        if failed.iter().any(|path| path == Path::new(&root.path)) {
            root.state = MacRootState::Retrying;
        }
    }
    Ok(())
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.tasks.send(WorkerSignal::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn read_settings(settings: &ScanRuleStore) -> Result<ScanRules, IndexError> {
    settings
        .get()
        .map_err(|_| IndexError("无法读取本地扫描规则。".to_owned()))
}

fn sync_settings(index: &MacFileIndex, settings: &ScanRuleStore) -> Result<ScanRules, IndexError> {
    settings
        .with_rules(|rules| {
            index.configure(rules)?;
            Ok(rules.clone())
        })
        .map_err(|_| IndexError("无法读取本地扫描规则。".to_owned()))?
}

fn run_worker(
    index: MacFileIndex,
    settings: ScanRuleStore,
    commands: Receiver<WorkerSignal>,
    diagnostic: Arc<Mutex<Result<Vec<PathBuf>, String>>>,
) {
    let mut active_volumes = BTreeMap::new();
    let mut generation = None;
    let mut cycle = |retry_pending| {
        let result = sync_settings(&index, &settings).and_then(|_| {
            update(
                &index,
                &settings,
                &mut generation,
                &mut active_volumes,
                retry_pending,
            )
        });
        if let Ok(mut diagnostic) = diagnostic.lock() {
            *diagnostic = result.map_err(|error| error.to_string());
        }
    };
    let mut retry_pending = false;
    loop {
        cycle(retry_pending);
        retry_pending = false;
        match commands.recv_timeout(WATCHER_INTERVAL) {
            Ok(WorkerSignal::Changed) => retry_pending = true,
            Err(RecvTimeoutError::Timeout) => {}
            Ok(WorkerSignal::Refresh(completion)) => {
                cycle(true);
                let _ = completion.try_send(());
            }
            Ok(WorkerSignal::Stop) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

struct VolumeWatch {
    volume: Volume,
    configured_roots: Vec<PathBuf>,
    watched_roots: Vec<PathBuf>,
    watchers: Vec<Watcher>,
    cursor: Option<u64>,
    initial_event_id: u64,
    events: Vec<MacEvent>,
    needs_recovery: bool,
    reset_cursor: bool,
    restart_streams: bool,
    retry_partial: bool,
    reconcile_on_start: bool,
}

impl VolumeWatch {
    fn start(
        index: &MacFileIndex,
        volume: Volume,
        configured_roots: Vec<PathBuf>,
    ) -> Result<Self, IndexError> {
        let initial_event_id = current_event_id();
        let saved_cursor = index.resume_cursor(&volume)?;
        let (cursor, needs_recovery) =
            if saved_cursor.is_some_and(|cursor| cursor > initial_event_id) {
                (None, true)
            } else {
                (saved_cursor, false)
            };
        let (watched_roots, watchers) = configured_roots
            .iter()
            .filter_map(|path| {
                Watcher::start(&volume, path, cursor).map(|watcher| (path.clone(), watcher))
            })
            .unzip();
        Ok(Self {
            volume,
            configured_roots,
            watched_roots,
            watchers,
            cursor,
            initial_event_id,
            events: vec![],
            needs_recovery,
            reset_cursor: needs_recovery,
            restart_streams: false,
            retry_partial: false,
            reconcile_on_start: true,
        })
    }

    fn reconcile_pending(
        &mut self,
        index: &MacFileIndex,
        settings: &ScanRuleStore,
        generation: i64,
    ) -> Result<bool, IndexError> {
        if self.watchers.is_empty() {
            return Ok(false);
        }
        let through = current_event_id();
        for watcher in &self.watchers {
            watcher.flush();
        }
        if self.cursor.is_some_and(|cursor| cursor > through) {
            self.reset_cursor = true;
            self.restart_streams = true;
            self.needs_recovery = true;
        }
        if !self.reset_cursor
            && self
                .watchers
                .iter()
                .any(|watcher| !watcher.history_complete())
        {
            return Ok(false);
        }
        for watcher in &self.watchers {
            let recovery = watcher.take(through, &mut self.events);
            self.needs_recovery |= recovery.rescan;
            self.reset_cursor |= recovery.reset_cursor;
            self.restart_streams |= recovery.restart;
        }
        if self.events.is_empty()
            && !self.reconcile_on_start
            && !self.needs_recovery
            && !self.retry_partial
        {
            return Ok(false);
        }
        let high_water_mark = if self.reset_cursor {
            self.events.clear();
            current_event_id()
        } else {
            self.events
                .iter()
                .map(|event| event.id)
                .max()
                .unwrap_or_else(|| self.cursor.unwrap_or(self.initial_event_id))
                .max(self.cursor.unwrap_or(0))
        };
        index.reconcile_volume(
            MacVolumeBatch {
                volume_id: &self.volume.id,
                event_store_id: &self.volume.event_store,
                device: self.volume.device,
                high_water_mark,
                events: &self.events,
                history_lost: self.needs_recovery,
            },
            Some((settings, generation, &self.watched_roots)),
            self.retry_partial,
        )?;
        self.cursor = Some(high_water_mark);
        self.events.clear();
        self.needs_recovery = false;
        self.reset_cursor = false;
        self.retry_partial = false;
        self.reconcile_on_start = false;
        Ok(std::mem::take(&mut self.restart_streams))
    }
}

fn update(
    index: &MacFileIndex,
    settings: &ScanRuleStore,
    watch_generation: &mut Option<i64>,
    active: &mut BTreeMap<u64, VolumeWatch>,
    retry_pending: bool,
) -> Result<Vec<PathBuf>, IndexError> {
    let Some(config) = index.configuration()? else {
        return Ok(vec![]);
    };
    if *watch_generation != Some(config.generation) {
        active.clear();
        *watch_generation = Some(config.generation);
    }
    let policy = scan_policy(&config.rules);
    let mut discovered: BTreeMap<u64, (Option<Volume>, Vec<PathBuf>)> = BTreeMap::new();
    let mut unavailable = Vec::new();
    for root in &config.roots {
        let path = Path::new(&root.path);
        if policy.macos_path_access(path) == MacPathAccess::Excluded {
            continue;
        }
        let Some(metadata) = root_metadata(path, &policy) else {
            unavailable.push(path.to_path_buf());
            continue;
        };
        let device = metadata.dev();
        discovered
            .entry(device)
            .or_insert_with(|| (Volume::for_path(path, device), vec![]))
            .1
            .push(path.to_path_buf());
    }
    active.retain(|device, _| discovered.contains_key(device));
    for (device, (volume, roots)) in discovered {
        let Some(volume) = volume else {
            active.remove(&device);
            unavailable.extend(roots);
            continue;
        };
        if !active.get(&device).is_some_and(|watch| {
            watch.volume == volume
                && watch.configured_roots == roots
                && watch.watched_roots == roots
        }) {
            active.insert(device, VolumeWatch::start(index, volume, roots)?);
        }
        let watch = &active[&device];
        unavailable.extend(
            watch
                .configured_roots
                .iter()
                .filter(|root| !watch.watched_roots.contains(root))
                .cloned(),
        );
    }
    index.roots_unavailable(config.generation, &unavailable)?;
    let mut restart = Vec::new();
    let mut failed = Vec::new();
    for (device, watch) in active.iter_mut() {
        if retry_pending
            && config.roots.iter().any(|root| {
                root.state == MacRootState::Partial
                    && watch
                        .watched_roots
                        .iter()
                        .any(|path| path == Path::new(&root.path))
            })
        {
            watch.retry_partial = true;
        }
        match watch.reconcile_pending(index, settings, config.generation) {
            Ok(true) => restart.push(*device),
            Ok(false) => {}
            Err(_) => failed.extend(watch.watched_roots.iter().cloned()),
        }
    }
    for device in restart {
        active.remove(&device);
    }
    Ok(failed)
}
