use crate::{
    contracts::{FileRecord, FileRecordInput, LocalDayRange},
    database::{AppError, Database},
};
use rusqlite::OptionalExtension;

#[derive(Clone)]
pub struct FileRepository {
    database: Database,
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::{file_index::macos::MAC_INDEX_SOURCE, scan::file_filter::FileTypeFilter};

    #[test]
    fn macos_publication_keeps_identities_and_retires_only_covered_rows() {
        let database = Database::open(Path::new(":memory:")).expect("database");
        let files = database.files();
        let range = LocalDayRange::new(1000, 2000);
        let mut fixture = FileRecordInput {
            canonical_path: "/Work/报告.md".to_owned(),
            file_identity: "mac:volume:1".to_owned(),
            modified_at_utc_ms: 1000,
            size_bytes: 3,
            source: MAC_INDEX_SOURCE.to_owned(),
        };
        let first = files
            .publish_macos_index(
                range,
                &[fixture.clone()],
                &FileTypeFilter::default(),
                &["/Work"],
            )
            .unwrap();
        let untouched = FileRecordInput {
            canonical_path: "/WorkOld/旧记录.md".to_owned(),
            ..fixture.clone()
        };
        files.upsert(&untouched).unwrap();
        let legacy = FileRecordInput {
            canonical_path: "/Work/旧来源.md".to_owned(),
            source: "浏览历史".to_owned(),
            ..fixture.clone()
        };
        files.upsert(&legacy).unwrap();
        fixture.size_bytes = 12;
        let refreshed = files
            .publish_macos_index(
                range,
                &[fixture.clone()],
                &FileTypeFilter::default(),
                &["/Work"],
            )
            .unwrap();
        assert_eq!(refreshed[0].id, first[0].id);
        assert_eq!(refreshed[0].size_bytes, 12);
        files
            .publish_macos_index(range, &[], &FileTypeFilter::default(), &["/Work"])
            .unwrap();
        assert!(files.get_by_id(first[0].id).unwrap().is_none());
        fixture.file_identity = "mac:volume:2".to_owned();
        let replacement = files
            .publish_macos_index(range, &[fixture], &FileTypeFilter::default(), &["/Work"])
            .unwrap();
        assert_ne!(replacement[0].id, first[0].id);
        assert!(files.get_by_id(first[0].id).unwrap().is_none());
        assert_eq!(files.list_for_local_day(range).unwrap().len(), 3);
    }

    #[test]
    fn macos_business_id_is_not_reused_after_deletion_commits() {
        let database = Database::open(Path::new(":memory:")).unwrap();
        let files = database.files();
        let day = LocalDayRange::new(1, 100);
        let mut file = FileRecordInput {
            canonical_path: "/Work/替换.md".to_owned(),
            file_identity: "mac:volume:old".to_owned(),
            modified_at_utc_ms: 2,
            size_bytes: 7,
            source: MAC_INDEX_SOURCE.to_owned(),
        };
        let old_id = files
            .publish_macos_index(
                day,
                std::slice::from_ref(&file),
                &FileTypeFilter::default(),
                &["/Work"],
            )
            .unwrap()[0]
            .id;
        files
            .publish_macos_index(day, &[], &FileTypeFilter::default(), &["/Work"])
            .unwrap();
        file.file_identity = "mac:volume:new".to_owned();
        let new_id = files
            .publish_macos_index(day, &[file], &FileTypeFilter::default(), &["/Work"])
            .unwrap()[0]
            .id;
        assert_ne!(old_id, new_id);
        assert!(files.get_by_id(old_id).unwrap().is_none());
    }

    #[test]
    fn hiding_a_file_category_does_not_retire_its_existing_records() {
        let database = Database::open(Path::new(":memory:")).unwrap();
        let files = database.files();
        let day = LocalDayRange::new(1, 100);
        let image = FileRecordInput {
            canonical_path: "/Work/图片.png".to_owned(),
            file_identity: "mac:volume:img".to_owned(),
            modified_at_utc_ms: 2,
            size_bytes: 7,
            source: MAC_INDEX_SOURCE.to_owned(),
        };
        let image_filters =
            FileTypeFilter::new(vec![crate::scan::file_filter::FileCategory::Images]);
        let original = std::slice::from_ref(&image);
        let first = files
            .publish_macos_index(day, original, &image_filters, &["/Work"])
            .unwrap();
        assert!(
            files
                .publish_macos_index(day, original, &FileTypeFilter::default(), &["/Work"])
                .unwrap()
                .is_empty()
        );
        let enabled = files
            .publish_macos_index(day, original, &image_filters, &["/Work"])
            .unwrap();
        assert_eq!(enabled[0].id, first[0].id);
    }
}

impl FileRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn upsert(&self, record: &FileRecordInput) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO file_records(canonical_path,file_identity,modified_at_utc_ms,size_bytes,source) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(canonical_path,file_identity) DO UPDATE SET modified_at_utc_ms=excluded.modified_at_utc_ms,size_bytes=excluded.size_bytes,source=excluded.source,present_in_index=1",
                (&record.canonical_path, &record.file_identity, record.modified_at_utc_ms, record.size_bytes, &record.source),
            )?;
            Ok(())
        })
    }

    pub fn replace_indexed_for_local_day(
        &self,
        day: LocalDayRange,
        records: &[FileRecordInput],
    ) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            transaction.execute(
                "DELETE FROM file_records WHERE modified_at_utc_ms >= ?1 AND modified_at_utc_ms < ?2 AND source IN ('本机文件','本机 NTFS 索引')",
                (day.start_utc_ms, day.next_start_utc_ms),
            )?;
            for record in records {
                transaction.execute(
                    "INSERT INTO file_records(canonical_path,file_identity,modified_at_utc_ms,size_bytes,source) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(canonical_path,file_identity) DO UPDATE SET modified_at_utc_ms=excluded.modified_at_utc_ms,size_bytes=excluded.size_bytes,source=excluded.source,present_in_index=1",
                    (&record.canonical_path, &record.file_identity, record.modified_at_utc_ms, record.size_bytes, &record.source),
                )?;
            }
            Ok(())
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn publish_macos_index(
        &self,
        day: LocalDayRange,
        records: &[FileRecordInput],
        filter: &crate::scan::file_filter::FileTypeFilter,
        complete_roots: &[&str],
    ) -> Result<Vec<FileRecord>, AppError> {
        use crate::file_index::macos::MAC_INDEX_SOURCE;
        use std::{collections::HashSet, path::Path};

        self.database.with_transaction(|transaction| {
            let mut write_record = transaction.prepare_cached(
                "INSERT INTO file_records (canonical_path,file_identity,modified_at_utc_ms,size_bytes,source)
                 VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(canonical_path,file_identity) DO UPDATE SET modified_at_utc_ms=excluded.modified_at_utc_ms,
                 size_bytes=excluded.size_bytes,source=excluded.source,present_in_index=1 RETURNING id",
            )?;
            let mut output = Vec::with_capacity(records.len());
            for record in records.iter().filter(|record| filter.allows(Path::new(&record.canonical_path))) {
                let id = write_record.query_row(
                    (&record.canonical_path, &record.file_identity, record.modified_at_utc_ms, record.size_bytes, MAC_INDEX_SOURCE),
                    |row| row.get(0),
                )?;
                output.push(FileRecord {
                    id,
                    canonical_path: record.canonical_path.clone(),
                    file_identity: record.file_identity.clone(),
                    modified_at_utc_ms: record.modified_at_utc_ms,
                    size_bytes: record.size_bytes,
                    source: MAC_INDEX_SOURCE.to_owned(),
                });
            }
            if !complete_roots.is_empty() {
                let current = records.iter().map(|record| (record.canonical_path.as_str(), record.file_identity.as_str())).collect::<HashSet<_>>();
                let mut previous = transaction.prepare_cached(
                    "SELECT id, canonical_path, file_identity FROM file_records WHERE source=?1 AND present_in_index=1 AND modified_at_utc_ms >= ?2 AND modified_at_utc_ms < ?3",
                )?;
                let stale = previous.query_map((MAC_INDEX_SOURCE, day.start_utc_ms, day.next_start_utc_ms), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?.collect::<rusqlite::Result<Vec<_>>>()?;
                let mut retire = transaction.prepare_cached("UPDATE file_records SET present_in_index=0 WHERE id=?1")?;
                for (id, path, identity) in stale {
                    if !current.contains(&(path.as_str(), identity.as_str())) && complete_roots.iter().any(|root| Path::new(&path).starts_with(root)) {
                        retire.execute([id])?;
                    }
                }
            }
            Ok(output)
        })
    }

    pub fn count(&self) -> Result<i64, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM file_records WHERE present_in_index=1",
                [],
                |row| row.get(0),
            )
        })
    }

    pub fn list_for_local_day(&self, day: LocalDayRange) -> Result<Vec<FileRecord>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT id,canonical_path,file_identity,modified_at_utc_ms,size_bytes,source FROM file_records WHERE present_in_index=1 AND modified_at_utc_ms >= ?1 AND modified_at_utc_ms < ?2 ORDER BY modified_at_utc_ms ASC")?;
            statement.query_map((day.start_utc_ms, day.next_start_utc_ms), |row| Ok(FileRecord { id: row.get(0)?, canonical_path: row.get(1)?, file_identity: row.get(2)?, modified_at_utc_ms: row.get(3)?, size_bytes: row.get(4)?, source: row.get(5)? }))?.collect()
        })
    }

    pub fn get_by_id(&self, id: i64) -> Result<Option<FileRecord>, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row("SELECT id,canonical_path,file_identity,modified_at_utc_ms,size_bytes,source FROM file_records WHERE present_in_index=1 AND id = ?1", [id], |row| Ok(FileRecord { id: row.get(0)?, canonical_path: row.get(1)?, file_identity: row.get(2)?, modified_at_utc_ms: row.get(3)?, size_bytes: row.get(4)?, source: row.get(5)? })).optional()
        })
    }

    pub fn get_by_identity(
        &self,
        canonical_path: &str,
        file_identity: &str,
    ) -> Result<Option<FileRecord>, AppError> {
        self.database.with_connection(|connection| {
            connection.query_row("SELECT id,canonical_path,file_identity,modified_at_utc_ms,size_bytes,source FROM file_records WHERE present_in_index=1 AND canonical_path = ?1 AND file_identity = ?2", (canonical_path, file_identity), |row| Ok(FileRecord { id: row.get(0)?, canonical_path: row.get(1)?, file_identity: row.get(2)?, modified_at_utc_ms: row.get(3)?, size_bytes: row.get(4)?, source: row.get(5)? })).optional()
        })
    }

    pub fn delete_by_id(&self, id: i64) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            #[cfg(target_os = "macos")]
            if connection.execute(
                "UPDATE file_records SET present_in_index=0 WHERE id=?1 AND source=?2",
                (id, crate::file_index::macos::MAC_INDEX_SOURCE),
            )? > 0
            {
                return Ok(());
            }
            connection.execute("DELETE FROM file_records WHERE id = ?1", [id])?;
            Ok(())
        })
    }
}
