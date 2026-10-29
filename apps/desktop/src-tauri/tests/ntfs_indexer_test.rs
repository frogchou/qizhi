use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    database::Database,
    ntfs::{
        DiscoveredEvent, IndexEntry, IndexProgressState, IndexSourcePage, JournalCursor,
        NtfsIndexer, UsnCheckpoint, UsnVolumeSource, VolumeDescriptor, VolumeState,
    },
};

fn temporary_database_path(name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("qizhi-{name}-{nonce}.sqlite"))
}

#[cfg(windows)]
#[test]
#[ignore = "requires a UAC-installed service and an explicit NTFS integration volume"]
fn reads_a_real_usn_journal_when_a_test_volume_is_explicitly_provided() {
    use qizhi_desktop_lib::ntfs::WindowsUsnVolumeSource;

    let mount_path = std::env::var("QIZHI_NTFS_SMOKE_VOLUME")
        .expect("set QIZHI_NTFS_SMOKE_VOLUME to the dedicated NTFS test volume");
    let volume = VolumeDescriptor {
        volume_guid: mount_path.clone(),
        current_mount_path: mount_path,
        serial_number: None,
        file_system: "NTFS".to_owned(),
        state: VolumeState::Ready,
        state_message: None,
    };

    let journal = WindowsUsnVolumeSource
        .current_journal(&volume)
        .expect("the configured NTFS volume exposes its USN journal");

    assert!(!journal.journal_id.is_empty());
}

fn volume() -> VolumeDescriptor {
    VolumeDescriptor {
        volume_guid: r"\\?\Volume{work}".to_owned(),
        current_mount_path: r"D:\".to_owned(),
        serial_number: Some("ABCD".to_owned()),
        file_system: "NTFS".to_owned(),
        state: VolumeState::Ready,
        state_message: None,
    }
}

fn page(next_usn: &str) -> IndexSourcePage {
    IndexSourcePage {
        entries: vec![IndexEntry {
            file_reference_number: "42".to_owned(),
            parent_file_reference_number: Some("5".to_owned()),
            name: "notes.md".to_owned(),
            is_directory: false,
            file_attributes: 0,
            size_bytes: Some(20),
            modified_at_utc_ms: Some(1_793_189_400_000),
            last_usn: next_usn.to_owned(),
            deleted_at_utc_ms: None,
        }],
        events: vec![DiscoveredEvent {
            file_reference_number: "42".to_owned(),
            canonical_path: r"D:\work\notes.md".to_owned(),
            event_kind: "modified".to_owned(),
            modified_at_utc_ms: 1_793_189_400_000,
            size_bytes: Some(20),
            source: "本机 NTFS 索引".to_owned(),
        }],
        next_usn: next_usn.to_owned(),
    }
}

struct ScriptedSource {
    journals: Mutex<VecDeque<JournalCursor>>,
    snapshot: Mutex<VecDeque<IndexSourcePage>>,
    replay: Mutex<VecDeque<IndexSourcePage>>,
}

impl UsnVolumeSource for ScriptedSource {
    fn current_journal(&self, _: &VolumeDescriptor) -> Result<JournalCursor, String> {
        self.journals
            .lock()
            .expect("lock")
            .pop_front()
            .ok_or_else(|| "missing scripted journal".to_owned())
    }

    fn visit_snapshot_pages(
        &self,
        _: &VolumeDescriptor,
        on_page: &mut dyn FnMut(IndexSourcePage) -> Result<(), String>,
    ) -> Result<(), String> {
        while let Some(page) = self.snapshot.lock().expect("lock").pop_front() {
            on_page(page)?;
        }
        Ok(())
    }

    fn visit_replay_pages(
        &self,
        _: &VolumeDescriptor,
        _: &UsnCheckpoint,
        on_page: &mut dyn FnMut(IndexSourcePage) -> Result<(), String>,
    ) -> Result<(), String> {
        while let Some(page) = self.replay.lock().expect("lock").pop_front() {
            on_page(page)?;
        }
        Ok(())
    }
}

#[test]
fn bootstraps_a_volume_then_replays_only_new_pages() {
    let path = temporary_database_path("ntfs-indexer");
    let database = Database::open(&path).expect("database opens");
    let source = ScriptedSource {
        journals: Mutex::new(VecDeque::from([
            JournalCursor {
                journal_id: "journal-1".to_owned(),
                first_usn: "1".to_owned(),
                next_usn: "4".to_owned(),
                record_major_version: 2,
            },
            JournalCursor {
                journal_id: "journal-1".to_owned(),
                first_usn: "1".to_owned(),
                next_usn: "4".to_owned(),
                record_major_version: 2,
            },
        ])),
        snapshot: Mutex::new(VecDeque::from([page("2")])),
        replay: Mutex::new(VecDeque::from([page("4")])),
    };
    let indexer = NtfsIndexer::new(database.ntfs_index(), source);

    let built = indexer.bootstrap(volume()).expect("bootstrap succeeds");
    let replayed = indexer.sync(&built.volume).expect("replay succeeds");
    let checkpoint = database
        .ntfs_index()
        .checkpoint_for(built.volume.id)
        .expect("checkpoint reads")
        .expect("checkpoint exists");

    assert_eq!(built.state, IndexProgressState::Ready);
    assert_eq!(replayed.changed_records, 1);
    assert_eq!(checkpoint.next_usn, "4");

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn marks_only_the_affected_volume_for_rebuild_when_its_journal_changes() {
    let path = temporary_database_path("ntfs-journal-reset");
    let database = Database::open(&path).expect("database opens");
    let source = ScriptedSource {
        journals: Mutex::new(VecDeque::from([
            JournalCursor {
                journal_id: "journal-1".to_owned(),
                first_usn: "1".to_owned(),
                next_usn: "4".to_owned(),
                record_major_version: 2,
            },
            JournalCursor {
                journal_id: "journal-2".to_owned(),
                first_usn: "1".to_owned(),
                next_usn: "4".to_owned(),
                record_major_version: 2,
            },
        ])),
        snapshot: Mutex::new(VecDeque::from([page("2")])),
        replay: Mutex::new(VecDeque::new()),
    };
    let indexer = NtfsIndexer::new(database.ntfs_index(), source);
    let built = indexer.bootstrap(volume()).expect("bootstrap succeeds");
    let result = indexer
        .sync(&built.volume)
        .expect("sync returns a rebuild state");

    assert_eq!(result.state, IndexProgressState::RebuildRequired);
    assert_eq!(result.changed_records, 0);

    drop(database);
    let _ = std::fs::remove_file(path);
}

#[test]
fn recovers_an_interrupted_initial_index_by_bootstrapping_after_sync_requests_rebuild() {
    let path = temporary_database_path("ntfs-rebuild-recovery");
    let database = Database::open(&path).expect("database opens");
    let descriptor = volume();
    database
        .ntfs_index()
        .upsert_volume(&descriptor)
        .expect("persist interrupted volume row");
    let source = ScriptedSource {
        journals: Mutex::new(VecDeque::from([
            JournalCursor {
                journal_id: "journal-1".to_owned(),
                first_usn: "1".to_owned(),
                next_usn: "4".to_owned(),
                record_major_version: 2,
            },
            JournalCursor {
                journal_id: "journal-1".to_owned(),
                first_usn: "1".to_owned(),
                next_usn: "4".to_owned(),
                record_major_version: 2,
            },
        ])),
        snapshot: Mutex::new(VecDeque::from([page("4")])),
        replay: Mutex::new(VecDeque::new()),
    };
    let indexer = NtfsIndexer::new(database.ntfs_index(), source);
    let interrupted = database
        .ntfs_index()
        .volume_by_guid(&descriptor.volume_guid)
        .expect("read volume")
        .expect("volume exists");

    let sync = indexer
        .sync(&interrupted)
        .expect("sync returns rebuild request");
    assert_eq!(sync.state, IndexProgressState::RebuildRequired);

    let rebuilt = indexer
        .bootstrap(descriptor)
        .expect("bootstrap recovers index");
    assert_eq!(rebuilt.state, IndexProgressState::Ready);
    assert_eq!(rebuilt.processed_records, 1);

    drop(database);
    let _ = std::fs::remove_file(path);
}
