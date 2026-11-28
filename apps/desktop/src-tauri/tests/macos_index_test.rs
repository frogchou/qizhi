#![cfg(target_os = "macos")]

use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

use qizhi_desktop_lib::{
    contracts::LocalDayRange,
    file_index::macos::{MacEvent, MacFileIndex, MacRootState, MacVolumeBatch, MacWorkspaceIndex},
    scan::configuration::{ScanRuleStore, ScanRules},
};

struct Fixture {
    root: PathBuf,
    database: PathBuf,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().expect("test directory");
        let parent = directory
            .path()
            .canonicalize()
            .expect("canonical directory");
        let root = parent.join("工作资料");
        let database = parent.join("index");
        fs::create_dir(&root).expect("work directory");
        fs::create_dir(&database).expect("index directory");
        Self {
            root,
            database,
            _directory: directory,
        }
    }

    fn open(&self) -> MacFileIndex {
        MacFileIndex::open(&self.database).expect("open index")
    }

    fn rules(&self) -> ScanRules {
        ScanRules {
            allowed_roots: vec![self.root.to_str().unwrap().to_owned()],
            ..ScanRules::default()
        }
    }

    fn batch<'a>(&self, high_water_mark: u64, events: &'a [MacEvent]) -> MacVolumeBatch<'a> {
        MacVolumeBatch {
            volume_id: "test-volume",
            event_store_id: "test-event-store",
            device: fs::metadata(&self.root)
                .expect("mounted test directory")
                .dev(),
            high_water_mark,
            events,
            history_lost: false,
        }
    }
}

fn all_dates() -> LocalDayRange {
    LocalDayRange::new(0, i64::MAX)
}

#[test]
fn first_scan_and_online_rename_are_durable_and_commit_the_same_cursor() {
    let fixture = Fixture::new();
    let original = fixture.root.join("初稿.md");
    let renamed = fixture.root.join("终稿.md");
    fs::write(&original, "fixture").expect("create file");
    let index = fixture.open();
    index.configure(&fixture.rules()).expect("configure");
    assert_eq!(
        index.snapshot(all_dates()).unwrap().coverage[0].state,
        MacRootState::Building
    );

    index
        .reconcile(fixture.batch(5, &[]))
        .expect("scan work directory");
    let first = index.snapshot(all_dates()).expect("initial snapshot");
    assert_eq!(first.coverage[0].state, MacRootState::Ready);
    assert_eq!(first.records[0].canonical_path, original.to_str().unwrap());
    let identity = first.records[0].file_identity.clone();
    fs::rename(&original, &renamed).expect("rename fixture");
    let observed = first.records[0].modified_at_utc_ms + 20_000;
    index
        .reconcile(fixture.batch(
            7,
            &[
                MacEvent::rename(6, original, Some(observed)),
                MacEvent::rename(7, renamed.clone(), Some(observed)),
            ],
        ))
        .expect("reconcile paired rename notifications");
    drop(index);

    let reopened = fixture.open();
    assert_eq!(reopened.cursor("test-volume").unwrap(), Some(7));
    let recent = reopened
        .snapshot(LocalDayRange::new(observed, observed + 1))
        .unwrap();
    assert_eq!(recent.records.len(), 1);
    assert_eq!(recent.records[0].canonical_path, renamed.to_str().unwrap());
    assert_eq!(recent.records[0].file_identity, identity);
}

#[test]
fn dropped_events_rebuild_affected_scope_without_inventing_an_observation_time() {
    let fixture = Fixture::new();
    let original = fixture.root.join("上一版.md");
    let renamed = fixture.root.join("离线改名.md");
    fs::write(&original, "fixture").expect("create file");
    let index = fixture.open();
    index.configure(&fixture.rules()).expect("configure");
    index
        .reconcile(fixture.batch(4, &[]))
        .expect("initial scan");
    let written = index.snapshot(all_dates()).unwrap().records[0].modified_at_utc_ms;
    fs::rename(&original, &renamed).expect("rename while no event was received");

    let mut batch = fixture.batch(8, &[]);
    batch.history_lost = true;
    index.reconcile(batch).expect("repair the affected root");
    let repaired = index.snapshot(all_dates()).unwrap();
    assert_eq!(repaired.records.len(), 1);
    assert_eq!(
        repaired.records[0].canonical_path,
        renamed.to_str().unwrap()
    );
    assert_eq!(repaired.records[0].modified_at_utc_ms, written);
    assert_eq!(index.cursor("test-volume").unwrap(), Some(8));
}

#[test]
fn a_rebuilt_cursor_accepts_new_low_event_ids_and_retains_later_events() {
    let fixture = Fixture::new();
    let index = fixture.open();
    index.configure(&fixture.rules()).unwrap();
    index.reconcile(fixture.batch(100, &[])).unwrap();
    let mut wrapped = fixture.batch(2, &[]);
    wrapped.history_lost = true;
    index.reconcile(wrapped).unwrap();
    assert_eq!(index.cursor("test-volume").unwrap(), Some(2));

    let first = fixture.root.join("本轮.md");
    let later = fixture.root.join("下轮.md");
    fs::write(&first, "first").unwrap();
    fs::write(&later, "later").unwrap();
    let events = [
        MacEvent::rename(3, first.clone(), None),
        MacEvent::rename(3, first, None),
        MacEvent::rename(4, later, None),
    ];
    index.reconcile(fixture.batch(3, &events)).unwrap();
    assert_eq!(index.cursor("test-volume").unwrap(), Some(3));
    assert_eq!(index.snapshot(all_dates()).unwrap().records.len(), 1);
    index.reconcile(fixture.batch(4, &events)).unwrap();
    assert_eq!(index.snapshot(all_dates()).unwrap().records.len(), 2);
}

#[test]
fn saving_exclusions_hides_old_records_before_a_new_scan_occurs() {
    let fixture = Fixture::new();
    let private = fixture.root.join("排除目录");
    fs::create_dir(&private).expect("create private directory");
    fs::write(private.join("排除.md"), "fixture").expect("write private file");
    let index = fixture.open();
    let mut rules = fixture.rules();
    index.configure(&rules).expect("configure");
    index
        .reconcile(fixture.batch(1, &[]))
        .expect("initial scan");
    assert_eq!(index.snapshot(all_dates()).unwrap().records.len(), 1);

    rules
        .custom_exclusions
        .push(private.to_str().unwrap().to_owned());
    index.configure(&rules).expect("configure new exclusion");
    let current = index.snapshot(all_dates()).unwrap();
    assert!(current.records.is_empty());
    assert_eq!(index.cursor("test-volume").unwrap(), Some(1));
}

#[test]
fn rejected_sqlite_commit_keeps_previous_records_and_cursor_for_retry() {
    let fixture = Fixture::new();
    let old = fixture.root.join("仍在旧快照.md");
    let new = fixture.root.join("成功提交后可见.md");
    fs::write(&old, "first").expect("initial file");
    let index = fixture.open();
    index.configure(&fixture.rules()).unwrap();
    index.reconcile(fixture.batch(10, &[])).unwrap();
    fs::rename(&old, &new).expect("rename file");
    let sql = rusqlite::Connection::open(fixture.database.join("mac-file-index.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_cursor BEFORE UPDATE ON volume_positions BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    let changes = [
        MacEvent::rename(11, old.clone(), None),
        MacEvent::rename(12, new.clone(), None),
    ];

    assert!(index.reconcile(fixture.batch(12, &changes)).is_err());
    assert_eq!(index.cursor("test-volume").unwrap(), Some(10));
    let prior: String = sql
        .query_row("SELECT path FROM indexed_files", [], |row| row.get(0))
        .unwrap();
    assert_eq!(prior, old.to_str().unwrap());
    assert!(index.snapshot(all_dates()).unwrap().records.is_empty());

    sql.execute_batch("DROP TRIGGER reject_cursor").unwrap();
    index.reconcile(fixture.batch(12, &changes)).unwrap();
    assert_eq!(index.cursor("test-volume").unwrap(), Some(12));
    assert_eq!(
        index.snapshot(all_dates()).unwrap().records[0].canonical_path,
        new.to_str().unwrap()
    );
}

#[test]
fn missing_root_hides_only_its_own_results_and_recovers_on_the_same_volume() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("保留.md"), "one").unwrap();
    let unavailable = fixture.root.with_file_name("暂不可用");
    let moved = fixture.root.with_file_name("离线");
    fs::create_dir(&unavailable).unwrap();
    fs::write(unavailable.join("暂不显示.md"), "two").unwrap();
    let mut rules = fixture.rules();
    rules
        .allowed_roots
        .push(unavailable.to_str().unwrap().to_owned());
    let index = fixture.open();
    index.configure(&rules).unwrap();
    index.reconcile(fixture.batch(1, &[])).unwrap();
    assert_eq!(index.snapshot(all_dates()).unwrap().records.len(), 2);

    fs::rename(&unavailable, &moved).unwrap();
    index.reconcile(fixture.batch(2, &[])).unwrap();
    let partial = index.snapshot(all_dates()).unwrap();
    assert_eq!(partial.records.len(), 1);
    assert!(
        partial
            .coverage
            .iter()
            .any(|root| root.state == MacRootState::Unavailable)
    );
    assert_eq!(index.cursor("test-volume").unwrap(), Some(2));
    fs::rename(&moved, &unavailable).unwrap();
    index.reconcile(fixture.batch(3, &[])).unwrap();
    assert_eq!(index.snapshot(all_dates()).unwrap().records.len(), 2);
}

#[test]
fn previously_indexed_files_are_hidden_when_a_child_directory_can_no_longer_be_listed() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let blocked = fixture.root.join("权限改变");
    fs::create_dir(&blocked).unwrap();
    fs::write(blocked.join("私有.md"), "content").unwrap();
    fs::write(fixture.root.join("公开.md"), "content").unwrap();
    let index = fixture.open();
    index.configure(&fixture.rules()).unwrap();
    index.reconcile(fixture.batch(1, &[])).unwrap();
    assert_eq!(index.snapshot(all_dates()).unwrap().records.len(), 2);

    let original = fs::metadata(&blocked).unwrap().permissions();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o111)).unwrap();
    let can_list = fs::read_dir(&blocked).is_ok();
    let snapshot = index.snapshot(all_dates()).unwrap();
    fs::set_permissions(&blocked, original).unwrap();
    assert!(!can_list, "this fixture needs an unprivileged test user");
    assert_eq!(snapshot.coverage[0].state, MacRootState::Partial);
    assert_eq!(snapshot.records.len(), 1);
    assert!(snapshot.records[0].canonical_path.ends_with("公开.md"));
}

#[test]
fn native_runtime_recovers_an_offline_rename_and_then_observes_a_live_delete() {
    let fixture = Fixture::new();
    let settings = ScanRuleStore::open(
        &fixture.database.join("test-scan-rules.json"),
        fixture.rules(),
    )
    .unwrap();
    let old = fixture.root.join("旧题目.md");
    let new = fixture.root.join("换名称.md");
    fs::write(&old, "fixture").unwrap();
    let index = MacWorkspaceIndex::open(&fixture.database, settings.clone());
    let original = wait_for_runtime(&index, Some(&old));
    let original_modified = original.records[0].modified_at_utc_ms;
    drop(index);
    fs::rename(&old, &new).unwrap();

    let restored = MacWorkspaceIndex::open(&fixture.database, settings);
    let renamed = wait_for_runtime(&restored, Some(&new));
    assert_eq!(renamed.records[0].modified_at_utc_ms, original_modified);
    fs::remove_file(&new).unwrap();
    wait_for_runtime(&restored, None);
}

#[test]
fn native_runtime_shows_retrying_when_a_volume_cannot_commit_an_update() {
    let fixture = Fixture::new();
    let settings = ScanRuleStore::open(
        &fixture.database.join("test-scan-rules.json"),
        fixture.rules(),
    )
    .unwrap();
    let old = fixture.root.join("已提交.md");
    let new = fixture.root.join("等待更新.md");
    fs::write(&old, "existing").unwrap();
    let index = MacWorkspaceIndex::open(&fixture.database, settings);
    wait_for_runtime(&index, Some(&old));
    let sql = rusqlite::Connection::open(fixture.database.join("mac-file-index.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_cursor BEFORE UPDATE ON volume_positions BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    fs::rename(&old, &new).unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = index.snapshot(all_dates(), true).unwrap();
        if snapshot.coverage[0].state == MacRootState::Retrying {
            assert!(
                snapshot
                    .records
                    .iter()
                    .all(|record| record.canonical_path != new.to_str().unwrap())
            );
            break;
        }
        assert!(Instant::now() < deadline, "expected a retry status");
        thread::sleep(Duration::from_millis(100));
    }
    sql.execute_batch("DROP TRIGGER reject_cursor").unwrap();
    wait_for_runtime(&index, Some(&new));
}

fn wait_for_runtime(
    index: &MacWorkspaceIndex,
    expected: Option<&std::path::Path>,
) -> qizhi_desktop_lib::file_index::macos::MacIndexSnapshot {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = index
            .snapshot(all_dates(), true)
            .expect("read native index snapshot");
        if snapshot
            .coverage
            .iter()
            .any(|root| root.state == MacRootState::Ready)
            && match expected {
                Some(path) => {
                    snapshot.records.len() == 1
                        && snapshot.records[0].canonical_path == path.to_str().unwrap()
                }
                None => snapshot.records.is_empty(),
            }
        {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "expected native state was not reached: {:?}",
            snapshot.coverage
        );
        thread::sleep(Duration::from_millis(100));
    }
}
