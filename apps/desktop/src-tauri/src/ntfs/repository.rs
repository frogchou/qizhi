use rusqlite::{OptionalExtension, params};

use crate::{
    database::{AppError, Database},
    ntfs::{
        DiscoveredEvent, IndexPage, IndexedVolume, UsnCheckpoint, VolumeDescriptor, VolumeState,
    },
};

#[derive(Clone)]
pub struct NtfsIndexRepository {
    database: Database,
}

impl NtfsIndexRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn upsert_volume(&self, volume: &VolumeDescriptor) -> Result<IndexedVolume, AppError> {
        self.database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO ntfs_volumes(volume_guid,current_mount_path,serial_number,file_system,state,state_message) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(volume_guid) DO UPDATE SET current_mount_path=excluded.current_mount_path,serial_number=excluded.serial_number,file_system=excluded.file_system,state=excluded.state,state_message=excluded.state_message",
                params![
                    volume.volume_guid,
                    volume.current_mount_path,
                    volume.serial_number,
                    volume.file_system,
                    volume.state.as_str(),
                    volume.state_message,
                ],
            )?;
            connection.query_row(
                "SELECT id,current_mount_path,serial_number,file_system,state,state_message,last_indexed_at_utc_ms,last_error_at_utc_ms FROM ntfs_volumes WHERE volume_guid = ?1",
                [&volume.volume_guid],
                |row| {
                    let state: String = row.get(4)?;
                    Ok(IndexedVolume {
                        id: row.get(0)?,
                        descriptor: VolumeDescriptor {
                            volume_guid: volume.volume_guid.clone(),
                            current_mount_path: row.get(1)?,
                            serial_number: row.get(2)?,
                            file_system: row.get(3)?,
                            state: VolumeState::from_str(&state).ok_or(rusqlite::Error::InvalidQuery)?,
                            state_message: row.get(5)?,
                        },
                        last_indexed_at_utc_ms: row.get(6)?,
                        last_error_at_utc_ms: row.get(7)?,
                    })
                },
            )
        })
    }

    pub fn apply_page(&self, page: &IndexPage) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            let volume_exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM ntfs_volumes WHERE id = ?1)",
                [page.volume_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !volume_exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            for entry in &page.entries {
                transaction.execute(
                    "INSERT INTO ntfs_entries(volume_id,file_reference_number,parent_file_reference_number,name,is_directory,file_attributes,size_bytes,modified_at_utc_ms,last_usn,deleted_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(volume_id,file_reference_number) DO UPDATE SET parent_file_reference_number=excluded.parent_file_reference_number,name=excluded.name,is_directory=excluded.is_directory,file_attributes=excluded.file_attributes,size_bytes=excluded.size_bytes,modified_at_utc_ms=excluded.modified_at_utc_ms,last_usn=excluded.last_usn,deleted_at_utc_ms=excluded.deleted_at_utc_ms",
                    params![page.volume_id, entry.file_reference_number, entry.parent_file_reference_number, entry.name, entry.is_directory, entry.file_attributes, entry.size_bytes, entry.modified_at_utc_ms, entry.last_usn, entry.deleted_at_utc_ms],
                )?;
            }

            for event in &page.events {
                transaction.execute(
                    "INSERT INTO discovered_file_events(volume_id,file_reference_number,canonical_path,event_kind,modified_at_utc_ms,size_bytes,source) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(volume_id,file_reference_number) DO UPDATE SET canonical_path=excluded.canonical_path,event_kind=excluded.event_kind,modified_at_utc_ms=excluded.modified_at_utc_ms,size_bytes=excluded.size_bytes,source=excluded.source",
                    params![page.volume_id, event.file_reference_number, event.canonical_path, event.event_kind, event.modified_at_utc_ms, event.size_bytes, event.source],
                )?;
            }

            transaction.execute(
                "INSERT INTO ntfs_checkpoints(volume_id,usn_journal_id,next_usn,first_usn_seen,record_major_version,last_successful_sync_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(volume_id) DO UPDATE SET usn_journal_id=excluded.usn_journal_id,next_usn=excluded.next_usn,first_usn_seen=excluded.first_usn_seen,record_major_version=excluded.record_major_version,last_successful_sync_at_utc_ms=excluded.last_successful_sync_at_utc_ms",
                params![page.volume_id, page.checkpoint.usn_journal_id, page.checkpoint.next_usn, page.checkpoint.first_usn_seen, page.checkpoint.record_major_version, page.checkpoint.last_successful_sync_at_utc_ms],
            )?;
            Ok(())
        })
    }

    pub fn checkpoint_for(&self, volume_id: i64) -> Result<Option<UsnCheckpoint>, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row(
                "SELECT usn_journal_id,next_usn,first_usn_seen,record_major_version,last_successful_sync_at_utc_ms FROM ntfs_checkpoints WHERE volume_id = ?1",
                [volume_id],
                |row| Ok(UsnCheckpoint {
                    usn_journal_id: row.get(0)?,
                    next_usn: row.get(1)?,
                    first_usn_seen: row.get(2)?,
                    record_major_version: row.get(3)?,
                    last_successful_sync_at_utc_ms: row.get(4)?,
                }),
            ).optional()
        })
    }

    pub fn list_events_between(
        &self,
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredEvent>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT file_reference_number,canonical_path,event_kind,modified_at_utc_ms,size_bytes,source FROM discovered_file_events WHERE modified_at_utc_ms >= ?1 AND modified_at_utc_ms < ?2 ORDER BY modified_at_utc_ms DESC, id DESC",
            )?;
            statement
                .query_map([start_utc_ms, end_utc_ms], |row| {
                    Ok(DiscoveredEvent {
                        file_reference_number: row.get(0)?,
                        canonical_path: row.get(1)?,
                        event_kind: row.get(2)?,
                        modified_at_utc_ms: row.get(3)?,
                        size_bytes: row.get(4)?,
                        source: row.get(5)?,
                    })
                })?
                .collect()
        })
    }
}
