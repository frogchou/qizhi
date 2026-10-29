#[cfg(windows)]
use std::collections::HashSet;

#[cfg(windows)]
use crate::ntfs::{
    control::IndexExecutor,
    indexer::{IndexSourcePage, JournalCursor, NtfsIndexer, UsnVolumeSource},
    model::{CallerIndexPolicy, IndexEntry, UsnCheckpoint, VolumeDescriptor, VolumeState},
    replay::read_replay_page,
    repository::NtfsIndexRepository,
    snapshot::read_snapshot_page,
    usn::UsnRecord,
    volume::{VolumeQualification, inspect_volume},
    win32::{open_volume, query_journal},
};

#[cfg(windows)]
pub struct WindowsUsnVolumeSource;

#[cfg(windows)]
#[derive(Clone)]
pub struct WindowsIndexExecutor {
    repository: NtfsIndexRepository,
}

#[cfg(windows)]
impl WindowsIndexExecutor {
    pub fn new(repository: NtfsIndexRepository) -> Self {
        Self { repository }
    }

    fn execute(&self, policy: &CallerIndexPolicy, rebuild: bool) -> Result<(), String> {
        let mut seen_volumes = HashSet::new();
        let mut first_failure = None;
        for root in &policy.allowed_roots {
            let inspected = inspect_volume(root);
            if !seen_volumes.insert(inspected.volume_guid.clone()) {
                continue;
            }
            let mut descriptor = VolumeDescriptor {
                volume_guid: inspected.volume_guid,
                current_mount_path: inspected.mount_path,
                serial_number: (!inspected.serial_number.is_empty())
                    .then_some(inspected.serial_number),
                file_system: match &inspected.qualification {
                    VolumeQualification::Indexable => "NTFS".to_owned(),
                    VolumeQualification::Unsupported(message)
                    | VolumeQualification::Unavailable(message) => message.clone(),
                },
                state: VolumeState::Ready,
                state_message: None,
            };
            match inspected.qualification {
                VolumeQualification::Indexable => {
                    let indexer = NtfsIndexer::new(self.repository.clone(), WindowsUsnVolumeSource);
                    let indexed = self.repository.volume_by_guid(&descriptor.volume_guid);
                    let outcome = match (rebuild, indexed) {
                        (true, _) | (_, Ok(None)) => indexer.bootstrap(descriptor.clone()),
                        (false, Ok(Some(volume))) => match indexer.sync(&volume) {
                            // A previous bootstrap may have been interrupted after the volume row
                            // was created but before a checkpoint was published. Treat that state
                            // as a recoverable rebuild, not a successful empty synchronization.
                            Ok(progress)
                                if progress.state
                                    == crate::ntfs::IndexProgressState::RebuildRequired =>
                            {
                                indexer.bootstrap(descriptor.clone())
                            }
                            result => result,
                        },
                        (_, Err(_)) => Err(crate::ntfs::IndexerError::Source(
                            "无法读取本地 NTFS 索引状态".to_owned(),
                        )),
                    };
                    if let Err(error) = outcome {
                        descriptor.state = VolumeState::Failed;
                        descriptor.state_message = Some("建立或同步本地 NTFS 索引失败".to_owned());
                        if let Ok(volume) = self.repository.upsert_volume(&descriptor) {
                            let _ = self.repository.set_volume_state(
                                volume.id,
                                VolumeState::Failed,
                                descriptor.state_message.as_deref(),
                                Some(chrono::Utc::now().timestamp_millis()),
                            );
                        }
                        first_failure.get_or_insert_with(|| error.to_string());
                    }
                }
                VolumeQualification::Unsupported(message) => {
                    descriptor.state = VolumeState::Unsupported;
                    descriptor.state_message = Some(message);
                    let _ = self.repository.upsert_volume(&descriptor);
                }
                VolumeQualification::Unavailable(message) => {
                    descriptor.state = VolumeState::Unavailable;
                    descriptor.state_message = Some(message);
                    let _ = self.repository.upsert_volume(&descriptor);
                }
            }
        }
        first_failure.map_or(Ok(()), Err)
    }
}

#[cfg(windows)]
impl IndexExecutor for WindowsIndexExecutor {
    fn build(&self, policy: &CallerIndexPolicy) -> Result<(), String> {
        self.execute(policy, true)
    }

    fn sync(&self, policy: &CallerIndexPolicy) -> Result<(), String> {
        self.execute(policy, false)
    }
}

#[cfg(windows)]
impl UsnVolumeSource for WindowsUsnVolumeSource {
    fn current_journal(&self, volume: &VolumeDescriptor) -> Result<JournalCursor, String> {
        let handle = open_volume(&volume.current_mount_path).map_err(|error| error.to_string())?;
        let journal = query_journal(&handle).map_err(|error| error.to_string())?;
        Ok(JournalCursor {
            journal_id: journal.journal_id,
            first_usn: journal.first_usn.to_string(),
            next_usn: journal.next_usn.to_string(),
            record_major_version: 2,
        })
    }

    fn visit_snapshot_pages(
        &self,
        volume: &VolumeDescriptor,
        on_page: &mut dyn FnMut(IndexSourcePage) -> Result<(), String>,
    ) -> Result<(), String> {
        let handle = open_volume(&volume.current_mount_path).map_err(|error| error.to_string())?;
        let journal = query_journal(&handle).map_err(|error| error.to_string())?;
        let mut cursor = 0_u64;

        for _ in 0..1_000_000 {
            let page = match read_snapshot_page(&handle, cursor, i64::MAX) {
                Ok(page) => page,
                Err(error) if error.is_end_of_enumeration() => break,
                Err(error) => {
                    return Err(format!("无法读取 NTFS 元数据快照: {error:?}"));
                }
            };
            if page.records.is_empty() || page.next_file_reference_number == cursor {
                break;
            }
            cursor = page.next_file_reference_number;
            on_page(IndexSourcePage {
                next_usn: journal.next_usn.to_string(),
                entries: page.records.iter().map(entry_from_record).collect(),
                events: vec![],
            })?;
        }
        Ok(())
    }

    fn visit_replay_pages(
        &self,
        volume: &VolumeDescriptor,
        checkpoint: &UsnCheckpoint,
        on_page: &mut dyn FnMut(IndexSourcePage) -> Result<(), String>,
    ) -> Result<(), String> {
        let handle = open_volume(&volume.current_mount_path).map_err(|error| error.to_string())?;
        let journal_id = checkpoint
            .usn_journal_id
            .parse::<u64>()
            .map_err(|_| "本地 USN 检查点格式无效".to_owned())?;
        let mut cursor = checkpoint
            .next_usn
            .parse::<i64>()
            .map_err(|_| "本地 USN 检查点格式无效".to_owned())?;

        for _ in 0..1_000_000 {
            let page = read_replay_page(&handle, cursor, journal_id)
                .map_err(|error| format!("无法读取 NTFS 变更日志: {error:?}"))?;
            let next_usn = page
                .next_usn
                .parse::<i64>()
                .map_err(|_| "Windows 返回了无效的 USN 检查点".to_owned())?;
            if next_usn == cursor {
                break;
            }
            cursor = next_usn;
            on_page(IndexSourcePage {
                next_usn: cursor.to_string(),
                entries: page.records.iter().map(entry_from_record).collect(),
                events: vec![],
            })?;
        }
        Ok(())
    }
}

#[cfg(windows)]
fn entry_from_record(record: &UsnRecord) -> IndexEntry {
    IndexEntry {
        file_reference_number: record.file_reference_number.clone(),
        parent_file_reference_number: Some(record.parent_file_reference_number.clone()),
        name: record.name.clone(),
        is_directory: record.file_attributes & 0x10 != 0,
        file_attributes: i64::from(record.file_attributes),
        size_bytes: None,
        modified_at_utc_ms: filetime_to_unix_milliseconds(record.timestamp_filetime),
        last_usn: record.usn.clone(),
        deleted_at_utc_ms: record
            .reasons
            .contains(crate::ntfs::usn::USN_REASON_FILE_DELETE)
            .then_some(filetime_to_unix_milliseconds(record.timestamp_filetime))
            .flatten(),
    }
}

#[cfg(windows)]
fn filetime_to_unix_milliseconds(value: i64) -> Option<i64> {
    const WINDOWS_TO_UNIX_EPOCH_100NS: i64 = 116_444_736_000_000_000;
    value
        .checked_sub(WINDOWS_TO_UNIX_EPOCH_100NS)
        .map(|difference| difference / 10_000)
}

#[cfg(not(windows))]
pub struct WindowsUsnVolumeSource;

#[cfg(not(windows))]
#[derive(Clone)]
pub struct WindowsIndexExecutor;
