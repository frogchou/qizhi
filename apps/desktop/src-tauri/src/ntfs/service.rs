#[cfg(windows)]
use crate::ntfs::{
    indexer::{IndexSourcePage, JournalCursor, UsnVolumeSource},
    model::{IndexEntry, UsnCheckpoint, VolumeDescriptor},
    replay::read_replay_page,
    snapshot::read_snapshot_page,
    usn::UsnRecord,
    win32::{open_volume, query_journal},
};

#[cfg(windows)]
pub struct WindowsUsnVolumeSource;

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

    fn snapshot_pages(&self, volume: &VolumeDescriptor) -> Result<Vec<IndexSourcePage>, String> {
        let handle = open_volume(&volume.current_mount_path).map_err(|error| error.to_string())?;
        let journal = query_journal(&handle).map_err(|error| error.to_string())?;
        let mut cursor = 0_u64;
        let mut pages = Vec::new();

        for _ in 0..1_000_000 {
            let page = read_snapshot_page(&handle, cursor, journal.next_usn)
                .map_err(|error| format!("无法读取 NTFS 元数据快照: {error:?}"))?;
            if page.records.is_empty() || page.next_file_reference_number == cursor {
                break;
            }
            cursor = page.next_file_reference_number;
            pages.push(IndexSourcePage {
                next_usn: journal.next_usn.to_string(),
                entries: page.records.iter().map(entry_from_record).collect(),
                events: vec![],
            });
        }
        Ok(pages)
    }

    fn replay_pages(
        &self,
        volume: &VolumeDescriptor,
        checkpoint: &UsnCheckpoint,
    ) -> Result<Vec<IndexSourcePage>, String> {
        let handle = open_volume(&volume.current_mount_path).map_err(|error| error.to_string())?;
        let journal_id = checkpoint
            .usn_journal_id
            .parse::<u64>()
            .map_err(|_| "本地 USN 检查点格式无效".to_owned())?;
        let mut cursor = checkpoint
            .next_usn
            .parse::<i64>()
            .map_err(|_| "本地 USN 检查点格式无效".to_owned())?;
        let mut pages = Vec::new();

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
            pages.push(IndexSourcePage {
                next_usn: cursor.to_string(),
                entries: page.records.iter().map(entry_from_record).collect(),
                events: vec![],
            });
        }
        Ok(pages)
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
