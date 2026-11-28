use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::path::PathBuf;

use super::{
    IndexError, MAC_INDEX_SOURCE, MacRootState, MacVolumeBatch, RootUpdate,
    search::{normalized, write_short_terms},
    storage_error,
};
use crate::{
    contracts::{FileRecordInput, LocalDayRange},
    scan::configuration::ScanRules,
};

pub(super) struct Configuration {
    pub generation: i64,
    pub rules: ScanRules,
    pub roots: Vec<StoredRoot>,
}

pub(super) struct StoredRoot {
    pub path: String,
    pub volume: Option<String>,
    pub device: Option<String>,
    pub identity: Option<String>,
    pub state: MacRootState,
}

pub(super) fn cursor(
    connection: &Connection,
    volume_id: &str,
    event_store: Option<&str>,
) -> Result<Option<u64>, IndexError> {
    let stored: Option<String> = db(connection
        .query_row(
            "SELECT event_id FROM volume_positions WHERE volume = ?1 AND (?2 IS NULL OR event_store = ?2)",
            params![volume_id, event_store],
            |row| row.get(0),
        )
        .optional())?;
    stored
        .map(|value| value.parse().map_err(|_| storage_error()))
        .transpose()
}

pub(super) fn configuration(connection: &Connection) -> Result<Option<Configuration>, IndexError> {
    let saved: Option<(i64, String)> = db(connection
        .query_row(
            "SELECT generation, rules FROM index_configuration WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())?;
    let Some((generation, rules)) = saved else {
        return Ok(None);
    };
    let rules = serde_json::from_str(&rules).map_err(|_| storage_error())?;
    let mut statement = db(connection
        .prepare("SELECT path, volume, device, identity, state FROM scan_roots ORDER BY path"))?;
    let roots = db(statement.query_map([], |row| {
        Ok(StoredRoot {
            path: row.get(0)?,
            volume: row.get(1)?,
            device: row.get(2)?,
            identity: row.get(3)?,
            state: match row.get::<_, i64>(4)? {
                0 => MacRootState::Building,
                1 => MacRootState::Ready,
                2 => MacRootState::Partial,
                _ => MacRootState::Unavailable,
            },
        })
    }))?;
    Ok(Some(Configuration {
        generation,
        rules,
        roots: db(roots.collect())?,
    }))
}

pub(super) fn records_in_range(
    connection: &Connection,
    range: LocalDayRange,
) -> Result<Vec<FileRecordInput>, IndexError> {
    let mut statement = db(connection.prepare(
        "SELECT indexed_files.path, identity, change_ms, size_bytes FROM indexed_files
         WHERE change_ms >= ?1 AND change_ms < ?2 AND EXISTS (
            SELECT 1 FROM covered_root_files WHERE path = indexed_files.path
         ) ORDER BY change_ms, indexed_files.path",
    ))?;
    let records = db(statement.query_map(
        params![range.start_utc_ms, range.next_start_utc_ms],
        |row| {
            Ok(FileRecordInput {
                canonical_path: row.get(0)?,
                file_identity: row.get(1)?,
                modified_at_utc_ms: row.get(2)?,
                size_bytes: row.get(3)?,
                source: MAC_INDEX_SOURCE.to_owned(),
            })
        },
    ))?;
    db(records.collect())
}

pub(super) fn covering_roots(
    connection: &Connection,
    path: &str,
) -> Result<Vec<String>, IndexError> {
    let mut statement =
        db(connection.prepare_cached("SELECT root FROM covered_root_files WHERE path = ?1"))?;
    let roots = db(statement.query_map([path], |row| row.get(0)))?;
    db(roots.collect())
}

pub(super) fn commit_batch(
    connection: &mut Connection,
    generation: i64,
    batch: MacVolumeBatch<'_>,
    updates: &[RootUpdate],
) -> Result<(), IndexError> {
    let transaction = db(connection.transaction())?;
    check_generation(&transaction, generation)?;
    for update in updates {
        apply_root(&transaction, update, &batch)?;
    }
    if !updates.is_empty() {
        remove_orphans(&transaction)?;
    }
    db(transaction.execute(
        "INSERT INTO volume_positions (volume, event_store, event_id) VALUES (?1, ?2, ?3)
         ON CONFLICT(volume) DO UPDATE SET event_store = excluded.event_store, event_id = excluded.event_id",
        params![batch.volume_id, batch.event_store_id, batch.high_water_mark.to_string()],
    ))?;
    db(transaction.commit())
}

pub(super) fn mark_building(
    connection: &Connection,
    generation: i64,
    volume: &str,
) -> Result<(), IndexError> {
    check_generation(connection, generation)?;
    db(connection.execute(
        "UPDATE scan_roots SET state = 0 WHERE volume = ?1",
        [volume],
    ))?;
    Ok(())
}

pub(super) fn check_generation(connection: &Connection, generation: i64) -> Result<(), IndexError> {
    let current: i64 = db(connection.query_row(
        "SELECT generation FROM index_configuration WHERE singleton = 1",
        [],
        |row| row.get(0),
    ))?;
    if current == generation {
        Ok(())
    } else {
        Err(IndexError(
            "扫描规则已变更，请按新范围更新索引。".to_owned(),
        ))
    }
}

pub(super) fn mark_unavailable(
    connection: &mut Connection,
    generation: i64,
    roots: &[PathBuf],
) -> Result<(), IndexError> {
    if roots.is_empty() {
        return Ok(());
    }
    let transaction = db(connection.transaction())?;
    check_generation(&transaction, generation)?;
    for root in roots {
        let root = root.to_str().ok_or_else(storage_error)?;
        db(transaction.execute(
            "UPDATE scan_roots SET state = 3 WHERE path = ?1 AND state != 3",
            [root],
        ))?;
    }
    db(transaction.commit())
}

fn apply_root(
    transaction: &Transaction<'_>,
    update: &RootUpdate,
    batch: &MacVolumeBatch<'_>,
) -> Result<(), IndexError> {
    let mut save_file = db(transaction.prepare_cached(
        "INSERT INTO indexed_files (path, identity, created_ms, modified_ms, observed_ms, size_bytes, search_path, search_name, search_prefix) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(path) DO UPDATE SET identity = excluded.identity, created_ms = excluded.created_ms,
         modified_ms = excluded.modified_ms, size_bytes = excluded.size_bytes,
         search_path = excluded.search_path, search_name = excluded.search_name, search_prefix = excluded.search_prefix,
         observed_ms = CASE WHEN indexed_files.identity = excluded.identity
             THEN max(indexed_files.observed_ms, excluded.observed_ms) ELSE excluded.observed_ms END
         RETURNING rowid",
    ))?;
    let mut add_membership =
        db(transaction
            .prepare_cached("INSERT OR IGNORE INTO root_files (root, path) VALUES (?1, ?2)"))?;
    let mut add_blocked = db(transaction
        .prepare_cached("INSERT OR IGNORE INTO blocked_directories (root, path) VALUES (?1, ?2)"))?;
    let search_prefix = normalized(&update.root);
    for boundary in &update.boundaries {
        let path = boundary.path.to_str().ok_or_else(storage_error)?;
        let prefix = format!("{path}/");
        db(transaction.execute(
            "DELETE FROM root_files WHERE root = ?1 AND (path = ?2 OR substr(path, 1, length(?3)) = ?3)",
            params![update.root, path, prefix],
        ))?;
        db(transaction.execute(
            "DELETE FROM blocked_directories WHERE root = ?1 AND (path = ?2 OR substr(path, 1, length(?3)) = ?3)",
            params![update.root, path, prefix],
        ))?;
        for file in &boundary.files {
            let search_path = normalized(&file.path);
            let search_name = search_path.rsplit('/').next().unwrap_or(&search_path);
            // Common root components are matched at query time. Repeating them per file
            // would dominate the short-term index on large directories.
            let relative = search_path
                .strip_prefix(&search_prefix)
                .unwrap_or(&search_path);
            let previous: Option<(i64, bool)> = db(db(transaction.prepare_cached(
                "SELECT modified_ms, search_prefix = ?2 FROM indexed_files WHERE path = ?1",
            ))?
            .query_row(params![file.path, search_prefix], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional())?;
            if previous.is_none() {
                remove_path_aliases(transaction, &file.path, &file.identity)?;
            }
            let id = db(save_file.query_row(
                params![
                    file.path,
                    file.identity,
                    file.created_ms,
                    file.modified_ms,
                    file.observed_ms,
                    file.size_bytes,
                    search_path,
                    search_name,
                    search_prefix,
                ],
                |row| row.get(0),
            ))?;
            if previous != Some((file.modified_ms, true)) {
                write_short_terms(
                    transaction,
                    id,
                    file.modified_ms,
                    relative,
                    search_name,
                    previous.is_some(),
                )?;
            }
            db(add_membership.execute(params![update.root, file.path]))?;
        }
        for path in &boundary.blocked {
            let path = path.to_str().ok_or_else(storage_error)?;
            db(add_blocked.execute(params![update.root, path]))?;
        }
    }
    let state = if update.identity.is_none() {
        MacRootState::Unavailable
    } else {
        let has_blocked: bool = db(transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM blocked_directories WHERE root = ?1)",
            [&update.root],
            |row| row.get(0),
        ))?;
        if has_blocked {
            MacRootState::Partial
        } else {
            MacRootState::Ready
        }
    };
    db(transaction.execute(
        "UPDATE scan_roots SET volume = ?1, device = ?2, identity = ?3, state = ?4 WHERE path = ?5",
        params![
            batch.volume_id,
            batch.device.to_string(),
            update.identity,
            state as i64,
            update.root
        ],
    ))?;
    Ok(())
}

fn remove_path_aliases(
    transaction: &Transaction<'_>,
    path: &str,
    identity: &str,
) -> Result<(), IndexError> {
    let mut select = db(transaction
        .prepare_cached("SELECT path FROM indexed_files WHERE identity = ?1 AND path != ?2"))?;
    let aliases = db(select.query_map(params![identity, path], |row| row.get::<_, String>(0)))?;
    let aliases: Vec<_> = db(aliases.collect())?;
    let expected = std::path::Path::new(path);
    for alias in aliases {
        // A different hard link resolves to its own directory entry. Remove only spelling aliases.
        if std::fs::canonicalize(&alias).is_ok_and(|canonical| canonical == expected) {
            db(transaction.execute("DELETE FROM indexed_files WHERE path = ?1", [alias]))?;
        }
    }
    Ok(())
}

pub(super) fn remove_orphans(transaction: &Transaction<'_>) -> Result<(), IndexError> {
    db(transaction.execute("DELETE FROM indexed_files WHERE NOT EXISTS (SELECT 1 FROM root_files WHERE root_files.path = indexed_files.path)", []))?;
    Ok(())
}

fn db<T>(value: rusqlite::Result<T>) -> Result<T, IndexError> {
    value.map_err(|_| storage_error())
}
