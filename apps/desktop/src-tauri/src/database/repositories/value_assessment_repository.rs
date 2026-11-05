use crate::{
    contracts::{FileValueAssessment, FileValueAssessmentInput},
    database::{AppError, Database},
};
use chrono::Utc;
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};

use crate::contracts::FileRecord;

#[derive(Clone)]
pub struct ValueAssessmentRepository {
    database: Database,
}

impl ValueAssessmentRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn save(&self, assessment: &FileValueAssessmentInput) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO file_value_assessments(canonical_path,file_identity,modified_at_utc_ms,status,score,confidence,message,evaluated_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(canonical_path,file_identity,modified_at_utc_ms) DO UPDATE SET status=excluded.status,score=excluded.score,confidence=excluded.confidence,message=excluded.message,evaluated_at_utc_ms=excluded.evaluated_at_utc_ms",
                (
                    &assessment.canonical_path,
                    &assessment.file_identity,
                    assessment.modified_at_utc_ms,
                    &assessment.status,
                    assessment.score,
                    assessment.confidence,
                    &assessment.message,
                    Utc::now().timestamp_millis(),
                ),
            )?;
            Ok(())
        })
    }

    pub fn find_for_file(
        &self,
        canonical_path: &str,
        file_identity: &str,
        modified_at_utc_ms: i64,
    ) -> Result<Option<FileValueAssessment>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT canonical_path,file_identity,modified_at_utc_ms,status,score,confidence,message,evaluated_at_utc_ms FROM file_value_assessments WHERE canonical_path=?1 AND file_identity=?2 AND modified_at_utc_ms=?3",
                    (canonical_path, file_identity, modified_at_utc_ms),
                    map_row,
                )
                .optional()
        })
    }

    pub fn list(&self) -> Result<Vec<FileValueAssessment>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT canonical_path,file_identity,modified_at_utc_ms,status,score,confidence,message,evaluated_at_utc_ms FROM file_value_assessments ORDER BY evaluated_at_utc_ms DESC",
            )?;
            statement.query_map([], map_row)?.collect()
        })
    }

    pub fn list_current_for_files(
        &self,
        files: &[FileRecord],
    ) -> Result<HashMap<i64, FileValueAssessment>, AppError> {
        let requested = files
            .iter()
            .map(|file| {
                (
                    file.canonical_path.clone(),
                    file.file_identity.clone(),
                    file.modified_at_utc_ms,
                )
            })
            .collect::<HashSet<_>>();
        let ids = files
            .iter()
            .map(|file| {
                (
                    (
                        file.canonical_path.clone(),
                        file.file_identity.clone(),
                        file.modified_at_utc_ms,
                    ),
                    file.id,
                )
            })
            .collect::<HashMap<_, _>>();
        Ok(self
            .list()?
            .into_iter()
            .filter_map(|assessment| {
                let key = (
                    assessment.canonical_path.clone(),
                    assessment.file_identity.clone(),
                    assessment.modified_at_utc_ms,
                );
                requested
                    .contains(&key)
                    .then(|| ids.get(&key).copied().map(|id| (id, assessment)))
                    .flatten()
            })
            .collect())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileValueAssessment> {
    Ok(FileValueAssessment {
        canonical_path: row.get(0)?,
        file_identity: row.get(1)?,
        modified_at_utc_ms: row.get(2)?,
        status: row.get(3)?,
        score: row.get(4)?,
        confidence: row.get(5)?,
        message: row.get(6)?,
        evaluated_at_utc_ms: row.get(7)?,
    })
}
