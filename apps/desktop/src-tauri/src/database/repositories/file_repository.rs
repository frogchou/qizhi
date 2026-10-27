use crate::{
    contracts::{FileRecord, FileRecordInput, LocalDayRange},
    database::{AppError, Database},
};
use rusqlite::OptionalExtension;

#[derive(Clone)]
pub struct FileRepository {
    database: Database,
}

impl FileRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn upsert(&self, record: &FileRecordInput) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO file_records(canonical_path,file_identity,modified_at_utc_ms,size_bytes,source) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(canonical_path,file_identity) DO UPDATE SET modified_at_utc_ms=excluded.modified_at_utc_ms,size_bytes=excluded.size_bytes,source=excluded.source",
                (&record.canonical_path, &record.file_identity, record.modified_at_utc_ms, record.size_bytes, &record.source),
            )?;
            Ok(())
        })
    }

    pub fn count(&self) -> Result<i64, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row("SELECT COUNT(*) FROM file_records", [], |row| row.get(0))
        })
    }

    pub fn list_for_local_day(&self, day: LocalDayRange) -> Result<Vec<FileRecord>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT id,canonical_path,file_identity,modified_at_utc_ms,size_bytes,source FROM file_records WHERE modified_at_utc_ms >= ?1 AND modified_at_utc_ms < ?2 ORDER BY modified_at_utc_ms ASC")?;
            statement.query_map((day.start_utc_ms, day.next_start_utc_ms), |row| Ok(FileRecord { id: row.get(0)?, canonical_path: row.get(1)?, file_identity: row.get(2)?, modified_at_utc_ms: row.get(3)?, size_bytes: row.get(4)?, source: row.get(5)? }))?.collect()
        })
    }

    pub fn get_by_id(&self, id: i64) -> Result<Option<FileRecord>, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row("SELECT id,canonical_path,file_identity,modified_at_utc_ms,size_bytes,source FROM file_records WHERE id = ?1", [id], |row| Ok(FileRecord { id: row.get(0)?, canonical_path: row.get(1)?, file_identity: row.get(2)?, modified_at_utc_ms: row.get(3)?, size_bytes: row.get(4)?, source: row.get(5)? })).optional()
        })
    }

    pub fn get_by_identity(
        &self,
        canonical_path: &str,
        file_identity: &str,
    ) -> Result<Option<FileRecord>, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row("SELECT id,canonical_path,file_identity,modified_at_utc_ms,size_bytes,source FROM file_records WHERE canonical_path = ?1 AND file_identity = ?2", (canonical_path, file_identity), |row| Ok(FileRecord { id: row.get(0)?, canonical_path: row.get(1)?, file_identity: row.get(2)?, modified_at_utc_ms: row.get(3)?, size_bytes: row.get(4)?, source: row.get(5)? })).optional()
        })
    }
}
