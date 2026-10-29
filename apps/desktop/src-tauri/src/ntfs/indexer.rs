use std::fmt;

use chrono::Utc;

use crate::{
    database::AppError,
    ntfs::{
        DiscoveredEvent, IndexEntry, IndexPage, IndexedVolume, NtfsIndexRepository, UsnCheckpoint,
        VolumeDescriptor, VolumeState,
    },
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalCursor {
    pub journal_id: String,
    pub first_usn: String,
    pub next_usn: String,
    pub record_major_version: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexSourcePage {
    pub entries: Vec<IndexEntry>,
    pub events: Vec<DiscoveredEvent>,
    pub next_usn: String,
}

pub trait UsnVolumeSource {
    fn current_journal(&self, volume: &VolumeDescriptor) -> Result<JournalCursor, String>;
    fn snapshot_pages(&self, volume: &VolumeDescriptor) -> Result<Vec<IndexSourcePage>, String>;
    fn replay_pages(
        &self,
        volume: &VolumeDescriptor,
        checkpoint: &UsnCheckpoint,
    ) -> Result<Vec<IndexSourcePage>, String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexProgressState {
    Building,
    Syncing,
    Ready,
    RebuildRequired,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexProgress {
    pub state: IndexProgressState,
    pub volume: IndexedVolume,
    pub processed_records: usize,
    pub changed_records: usize,
    pub message: Option<String>,
}

#[derive(Debug)]
pub enum IndexerError {
    Storage(AppError),
    Source(String),
}

impl fmt::Display for IndexerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Storage(_) => formatter.write_str("无法写入本地 NTFS 索引"),
            Self::Source(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for IndexerError {}

impl From<AppError> for IndexerError {
    fn from(value: AppError) -> Self {
        Self::Storage(value)
    }
}

pub struct NtfsIndexer<S> {
    repository: NtfsIndexRepository,
    source: S,
}

impl<S: UsnVolumeSource> NtfsIndexer<S> {
    pub fn new(repository: NtfsIndexRepository, source: S) -> Self {
        Self { repository, source }
    }

    pub fn bootstrap(
        &self,
        mut descriptor: VolumeDescriptor,
    ) -> Result<IndexProgress, IndexerError> {
        descriptor.state = VolumeState::Building;
        descriptor.state_message = Some("正在建立本地 NTFS 索引".to_owned());
        let volume = self.repository.upsert_volume(&descriptor)?;
        let build_id = format!("{}-{}", volume.id, Utc::now().timestamp_nanos_opt().unwrap_or_default());
        self.repository
            .begin_rebuild(volume.id, &build_id, Utc::now().timestamp_millis())?;
        let journal = self
            .source
            .current_journal(&descriptor)
            .map_err(IndexerError::Source)?;
        let pages = self
            .source
            .snapshot_pages(&descriptor)
            .map_err(IndexerError::Source)?;
        let mut processed_records = 0;
        let mut next_usn = journal.next_usn.clone();

        for page in pages {
            processed_records += page.entries.len();
            next_usn = page.next_usn.clone();
            self.stage_source_page(&volume, &build_id, &journal, page)?;
        }
        if processed_records == 0 {
            self.stage_source_page(
                &volume,
                &build_id,
                &journal,
                IndexSourcePage {
                    entries: vec![],
                    events: vec![],
                    next_usn: next_usn.clone(),
                },
            )?;
        }
        self.repository.publish_rebuild(
            volume.id,
            &build_id,
            Utc::now().timestamp_millis(),
        )?;
        let volume = self
            .repository
            .volume_by_guid(&descriptor.volume_guid)?
            .ok_or(AppError::Storage)?;
        Ok(IndexProgress {
            state: IndexProgressState::Ready,
            volume,
            processed_records,
            changed_records: 0,
            message: Some(format!("本地索引已建立，检查点 {next_usn}")),
        })
    }

    pub fn sync(&self, volume: &IndexedVolume) -> Result<IndexProgress, IndexerError> {
        let journal = self
            .source
            .current_journal(&volume.descriptor)
            .map_err(IndexerError::Source)?;
        let Some(checkpoint) = self.repository.checkpoint_for(volume.id)? else {
            return self.require_rebuild(volume, "缺少本地 USN 检查点");
        };
        if checkpoint.usn_journal_id != journal.journal_id
            || is_before(&checkpoint.next_usn, &journal.first_usn)
        {
            return self.require_rebuild(volume, "Windows USN 日志已重置或历史记录已被裁剪");
        }
        self.repository.set_volume_state(
            volume.id,
            VolumeState::Syncing,
            Some("正在同步 NTFS 变更"),
            None,
        )?;
        let pages = self
            .source
            .replay_pages(&volume.descriptor, &checkpoint)
            .map_err(IndexerError::Source)?;
        let mut changed_records = 0;
        for page in pages {
            changed_records += page.entries.len();
            self.apply_source_page(volume, &journal, page)?;
        }
        self.repository.set_volume_state(
            volume.id,
            VolumeState::Ready,
            None,
            Some(Utc::now().timestamp_millis()),
        )?;
        let volume = self
            .repository
            .volume_by_guid(&volume.descriptor.volume_guid)?
            .ok_or(AppError::Storage)?;
        Ok(IndexProgress {
            state: IndexProgressState::Ready,
            volume,
            processed_records: changed_records,
            changed_records,
            message: Some("本地索引已同步".to_owned()),
        })
    }

    fn apply_source_page(
        &self,
        volume: &IndexedVolume,
        journal: &JournalCursor,
        page: IndexSourcePage,
    ) -> Result<(), IndexerError> {
        self.repository.apply_page(&IndexPage {
            volume_id: volume.id,
            entries: page.entries,
            events: page.events,
            checkpoint: UsnCheckpoint {
                usn_journal_id: journal.journal_id.clone(),
                next_usn: page.next_usn,
                first_usn_seen: journal.first_usn.clone(),
                record_major_version: journal.record_major_version,
                last_successful_sync_at_utc_ms: Utc::now().timestamp_millis(),
            },
        })?;
        Ok(())
    }

    fn stage_source_page(
        &self,
        volume: &IndexedVolume,
        build_id: &str,
        journal: &JournalCursor,
        page: IndexSourcePage,
    ) -> Result<(), IndexerError> {
        self.repository.stage_rebuild_page(
            volume.id,
            build_id,
            &IndexPage {
                volume_id: volume.id,
                entries: page.entries,
                events: page.events,
                checkpoint: UsnCheckpoint {
                    usn_journal_id: journal.journal_id.clone(),
                    next_usn: page.next_usn,
                    first_usn_seen: journal.first_usn.clone(),
                    record_major_version: journal.record_major_version,
                    last_successful_sync_at_utc_ms: Utc::now().timestamp_millis(),
                },
            },
        )?;
        Ok(())
    }

    fn require_rebuild(
        &self,
        volume: &IndexedVolume,
        reason: &str,
    ) -> Result<IndexProgress, IndexerError> {
        self.repository.set_volume_state(
            volume.id,
            VolumeState::RebuildRequired,
            Some(reason),
            None,
        )?;
        let volume = self
            .repository
            .volume_by_guid(&volume.descriptor.volume_guid)?
            .ok_or(AppError::Storage)?;
        Ok(IndexProgress {
            state: IndexProgressState::RebuildRequired,
            volume,
            processed_records: 0,
            changed_records: 0,
            message: Some(reason.to_owned()),
        })
    }
}

fn is_before(left: &str, right: &str) -> bool {
    left.parse::<i128>().unwrap_or_default() < right.parse::<i128>().unwrap_or_default()
}
