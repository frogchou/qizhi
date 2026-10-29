use rusqlite::{OptionalExtension, params};

use crate::{
    database::{AppError, Database},
    ntfs::{
        CallerIndexPolicy, DiscoveredEvent, IndexPage, IndexedFileCandidate, IndexedVolume,
        UsnCheckpoint, VolumeDescriptor, VolumeState,
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

    pub fn begin_rebuild(
        &self,
        volume_id: i64,
        build_id: &str,
        started_at_utc_ms: i64,
    ) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            let volume_exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM ntfs_volumes WHERE id = ?1)",
                [volume_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !volume_exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            transaction.execute(
                "DELETE FROM ntfs_rebuild_entries WHERE volume_id = ?1",
                [volume_id],
            )?;
            transaction.execute(
                "DELETE FROM ntfs_rebuild_events WHERE volume_id = ?1",
                [volume_id],
            )?;
            transaction.execute(
                "DELETE FROM ntfs_rebuild_checkpoints WHERE volume_id = ?1",
                [volume_id],
            )?;
            transaction.execute("DELETE FROM ntfs_rebuilds WHERE volume_id = ?1", [volume_id])?;
            transaction.execute(
                "INSERT INTO ntfs_rebuilds(build_id,volume_id,started_at_utc_ms) VALUES (?1,?2,?3)",
                params![build_id, volume_id, started_at_utc_ms],
            )?;
            transaction.execute(
                "UPDATE ntfs_volumes SET state = 'building',state_message = '正在建立本地 NTFS 索引' WHERE id = ?1",
                [volume_id],
            )?;
            Ok(())
        })
    }

    pub fn stage_rebuild_page(
        &self,
        volume_id: i64,
        build_id: &str,
        page: &IndexPage,
    ) -> Result<(), AppError> {
        if page.volume_id != volume_id {
            return Err(AppError::Storage);
        }
        self.database.with_transaction(|transaction| {
            let build_exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM ntfs_rebuilds WHERE build_id = ?1 AND volume_id = ?2)",
                params![build_id, volume_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !build_exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            for entry in &page.entries {
                transaction.execute(
                    "INSERT INTO ntfs_rebuild_entries(build_id,volume_id,file_reference_number,parent_file_reference_number,name,is_directory,file_attributes,size_bytes,modified_at_utc_ms,last_usn,deleted_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(build_id,file_reference_number) DO UPDATE SET parent_file_reference_number=excluded.parent_file_reference_number,name=excluded.name,is_directory=excluded.is_directory,file_attributes=excluded.file_attributes,size_bytes=excluded.size_bytes,modified_at_utc_ms=excluded.modified_at_utc_ms,last_usn=excluded.last_usn,deleted_at_utc_ms=excluded.deleted_at_utc_ms",
                    params![build_id, volume_id, entry.file_reference_number, entry.parent_file_reference_number, entry.name, entry.is_directory, entry.file_attributes, entry.size_bytes, entry.modified_at_utc_ms, entry.last_usn, entry.deleted_at_utc_ms],
                )?;
            }
            for event in &page.events {
                transaction.execute(
                    "INSERT INTO ntfs_rebuild_events(build_id,volume_id,file_reference_number,canonical_path,event_kind,modified_at_utc_ms,size_bytes,source) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(build_id,file_reference_number) DO UPDATE SET canonical_path=excluded.canonical_path,event_kind=excluded.event_kind,modified_at_utc_ms=excluded.modified_at_utc_ms,size_bytes=excluded.size_bytes,source=excluded.source",
                    params![build_id, volume_id, event.file_reference_number, event.canonical_path, event.event_kind, event.modified_at_utc_ms, event.size_bytes, event.source],
                )?;
            }
            transaction.execute(
                "INSERT INTO ntfs_rebuild_checkpoints(build_id,volume_id,usn_journal_id,next_usn,first_usn_seen,record_major_version,last_successful_sync_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(build_id) DO UPDATE SET usn_journal_id=excluded.usn_journal_id,next_usn=excluded.next_usn,first_usn_seen=excluded.first_usn_seen,record_major_version=excluded.record_major_version,last_successful_sync_at_utc_ms=excluded.last_successful_sync_at_utc_ms",
                params![build_id, volume_id, page.checkpoint.usn_journal_id, page.checkpoint.next_usn, page.checkpoint.first_usn_seen, page.checkpoint.record_major_version, page.checkpoint.last_successful_sync_at_utc_ms],
            )?;
            Ok(())
        })
    }

    pub fn publish_rebuild(
        &self,
        volume_id: i64,
        build_id: &str,
        indexed_at_utc_ms: i64,
    ) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            let complete = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM ntfs_rebuild_checkpoints WHERE build_id = ?1 AND volume_id = ?2)",
                params![build_id, volume_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !complete {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            transaction.execute("DELETE FROM ntfs_entries WHERE volume_id = ?1", [volume_id])?;
            transaction.execute(
                "DELETE FROM discovered_file_events WHERE volume_id = ?1",
                [volume_id],
            )?;
            transaction.execute("DELETE FROM ntfs_checkpoints WHERE volume_id = ?1", [volume_id])?;
            transaction.execute(
                "INSERT INTO ntfs_entries(volume_id,file_reference_number,parent_file_reference_number,name,is_directory,file_attributes,size_bytes,modified_at_utc_ms,last_usn,deleted_at_utc_ms) SELECT volume_id,file_reference_number,parent_file_reference_number,name,is_directory,file_attributes,size_bytes,modified_at_utc_ms,last_usn,deleted_at_utc_ms FROM ntfs_rebuild_entries WHERE build_id = ?1",
                [build_id],
            )?;
            transaction.execute(
                "INSERT INTO discovered_file_events(volume_id,file_reference_number,canonical_path,event_kind,modified_at_utc_ms,size_bytes,source) SELECT volume_id,file_reference_number,canonical_path,event_kind,modified_at_utc_ms,size_bytes,source FROM ntfs_rebuild_events WHERE build_id = ?1",
                [build_id],
            )?;
            transaction.execute(
                "INSERT INTO ntfs_checkpoints(volume_id,usn_journal_id,next_usn,first_usn_seen,record_major_version,last_successful_sync_at_utc_ms) SELECT volume_id,usn_journal_id,next_usn,first_usn_seen,record_major_version,last_successful_sync_at_utc_ms FROM ntfs_rebuild_checkpoints WHERE build_id = ?1",
                [build_id],
            )?;
            transaction.execute(
                "UPDATE ntfs_volumes SET state = 'ready',state_message = NULL,last_indexed_at_utc_ms = ?2 WHERE id = ?1",
                params![volume_id, indexed_at_utc_ms],
            )?;
            transaction.execute("DELETE FROM ntfs_rebuild_entries WHERE build_id = ?1", [build_id])?;
            transaction.execute("DELETE FROM ntfs_rebuild_events WHERE build_id = ?1", [build_id])?;
            transaction.execute(
                "DELETE FROM ntfs_rebuild_checkpoints WHERE build_id = ?1",
                [build_id],
            )?;
            transaction.execute("DELETE FROM ntfs_rebuilds WHERE build_id = ?1", [build_id])?;
            Ok(())
        })
    }

    pub fn volume_by_guid(&self, volume_guid: &str) -> Result<Option<IndexedVolume>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id,current_mount_path,serial_number,file_system,state,state_message,last_indexed_at_utc_ms,last_error_at_utc_ms FROM ntfs_volumes WHERE volume_guid = ?1",
                    [volume_guid],
                    |row| {
                        let state: String = row.get(4)?;
                        Ok(IndexedVolume {
                            id: row.get(0)?,
                            descriptor: VolumeDescriptor {
                                volume_guid: volume_guid.to_owned(),
                                current_mount_path: row.get(1)?,
                                serial_number: row.get(2)?,
                                file_system: row.get(3)?,
                                state: VolumeState::from_str(&state)
                                    .ok_or(rusqlite::Error::InvalidQuery)?,
                                state_message: row.get(5)?,
                            },
                            last_indexed_at_utc_ms: row.get(6)?,
                            last_error_at_utc_ms: row.get(7)?,
                        })
                    },
                )
                .optional()
        })
    }

    pub fn set_volume_state(
        &self,
        volume_id: i64,
        state: VolumeState,
        state_message: Option<&str>,
        indexed_at_utc_ms: Option<i64>,
    ) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            let rows = connection.execute(
                "UPDATE ntfs_volumes SET state = ?2,state_message = ?3,last_indexed_at_utc_ms = COALESCE(?4,last_indexed_at_utc_ms),last_error_at_utc_ms = CASE WHEN ?2 = 'failed' THEN ?4 ELSE last_error_at_utc_ms END WHERE id = ?1",
                params![volume_id, state.as_str(), state_message, indexed_at_utc_ms],
            )?;
            if rows == 1 {
                Ok(())
            } else {
                Err(rusqlite::Error::QueryReturnedNoRows)
            }
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

    pub fn replace_caller_policy(&self, policy: &CallerIndexPolicy) -> Result<(), AppError> {
        let allowed_roots =
            serde_json::to_string(&policy.allowed_roots).map_err(|_| AppError::InvalidConfig)?;
        self.database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO ntfs_caller_policies(caller_sid,allowed_roots_json,updated_at_utc_ms) VALUES (?1,?2,?3) ON CONFLICT(caller_sid) DO UPDATE SET allowed_roots_json=excluded.allowed_roots_json,updated_at_utc_ms=excluded.updated_at_utc_ms",
                params![policy.caller_sid, allowed_roots, policy.updated_at_utc_ms],
            )?;
            Ok(())
        })
    }

    pub fn caller_policy(&self, caller_sid: &str) -> Result<Option<CallerIndexPolicy>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT allowed_roots_json,updated_at_utc_ms FROM ntfs_caller_policies WHERE caller_sid = ?1",
                    [caller_sid],
                    |row| {
                        let roots_json: String = row.get(0)?;
                        let allowed_roots = serde_json::from_str(&roots_json)
                            .map_err(|_| rusqlite::Error::InvalidQuery)?;
                        Ok(CallerIndexPolicy {
                            caller_sid: caller_sid.to_owned(),
                            allowed_roots,
                            updated_at_utc_ms: row.get(1)?,
                        })
                    },
                )
                .optional()
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

    pub fn list_file_candidates_between(
        &self,
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<IndexedFileCandidate>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "WITH RECURSIVE candidates AS (
                    SELECT volume_id,file_reference_number,parent_file_reference_number,name,modified_at_utc_ms,size_bytes
                    FROM ntfs_entries
                    WHERE is_directory = 0
                      AND deleted_at_utc_ms IS NULL
                      AND modified_at_utc_ms >= ?1
                      AND modified_at_utc_ms < ?2
                ), ancestry AS (
                    SELECT volume_id,file_reference_number AS target_reference,parent_file_reference_number,name,modified_at_utc_ms,size_bytes,name AS relative_path,0 AS depth
                    FROM candidates
                    UNION ALL
                    SELECT parent.volume_id,ancestry.target_reference,parent.parent_file_reference_number,parent.name,ancestry.modified_at_utc_ms,ancestry.size_bytes,
                           CASE WHEN parent.name IS NULL OR parent.name = '' OR parent.name = '.' THEN ancestry.relative_path ELSE parent.name || '\\' || ancestry.relative_path END,
                           ancestry.depth + 1
                    FROM ancestry
                    JOIN ntfs_entries parent ON parent.volume_id = ancestry.volume_id AND parent.file_reference_number = ancestry.parent_file_reference_number
                    WHERE ancestry.parent_file_reference_number IS NOT NULL
                      AND ancestry.depth < 128
                      AND parent.file_reference_number != ancestry.target_reference
                ), deepest AS (
                    SELECT volume_id,target_reference,MAX(depth) AS depth
                    FROM ancestry
                    GROUP BY volume_id,target_reference
                )
                SELECT ancestry.target_reference,ntfs_volumes.current_mount_path || ancestry.relative_path,ancestry.modified_at_utc_ms,ancestry.size_bytes
                FROM ancestry
                JOIN deepest ON deepest.volume_id = ancestry.volume_id AND deepest.target_reference = ancestry.target_reference AND deepest.depth = ancestry.depth
                JOIN ntfs_volumes ON ntfs_volumes.id = ancestry.volume_id
                ORDER BY ancestry.modified_at_utc_ms DESC, ancestry.target_reference ASC",
            )?;
            statement
                .query_map([start_utc_ms, end_utc_ms], |row| {
                    Ok(IndexedFileCandidate {
                        file_reference_number: row.get(0)?,
                        canonical_path: row.get(1)?,
                        modified_at_utc_ms: row.get(2)?,
                        size_bytes: row.get(3)?,
                    })
                })?
                .collect()
        })
    }
}
