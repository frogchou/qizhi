use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{
    IndexError, MAC_INDEX_SOURCE, MacFileIndex, MacRootCoverage, MacRootState, can_list_parents,
    file_identity, inode_identity, matches_file_identity, root_metadata, scan_policy,
    storage_error, store,
};
use crate::{
    contracts::FileRecordInput,
    scan::policy::{MacPathAccess, ScanPolicy},
};

const PAGE_SIZE: usize = 50;
const CANDIDATE_BATCH: i64 = 96;
const STALE: &str = "所选文件已移动、变更或不在当前允许范围内，请重新查找。";
const CURSOR_EXPIRED: &str = "查找范围已更新，请重新输入关键词。";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchInput {
    pub query: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchPage {
    pub files: Vec<FileSearchResult>,
    pub next_cursor: Option<String>,
    pub coverage: Vec<MacRootCoverage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub record_key: String,
    pub name: String,
    pub path: String,
    pub size_bytes: i64,
    pub modified_at_utc_ms: i64,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Position {
    rank: i64,
    modified_order: i64,
    id: i64,
}

#[derive(Deserialize, Serialize)]
struct SearchCursor {
    query: String,
    generation: i64,
    position: Position,
}

struct SearchCandidate {
    position: Position,
    record: FileRecordInput,
}

struct SearchRoot {
    coverage: MacRootCoverage,
    device: Option<u64>,
    volume: Option<String>,
}

pub(super) fn normalized(value: &str) -> String {
    let canonical: String = value.nfc().collect();
    unicase::UniCase::new(canonical)
        .to_folded_case()
        .nfc()
        .collect()
}

pub(super) fn write_short_terms(
    transaction: &Transaction<'_>,
    id: i64,
    modified_ms: i64,
    path: &str,
    name: &str,
    replace: bool,
) -> Result<(), IndexError> {
    if replace {
        transaction
            .prepare_cached("DELETE FROM indexed_file_short_terms WHERE file_id = ?1")
            .and_then(|mut statement| statement.execute([id]))
            .map_err(|_| storage_error())?;
    }
    let name_start = path.len() - name.len();
    let offsets = path
        .char_indices()
        .map(|(index, _)| index)
        .chain([path.len()])
        .collect::<Vec<_>>();
    let mut terms = BTreeMap::<&str, u8>::new();
    for (index, &start) in offsets.iter().enumerate() {
        for &end in offsets.iter().skip(index + 1).take(2) {
            let term = &path[start..end];
            let rank = if term == name {
                0
            } else if start >= name_start {
                1
            } else {
                2
            };
            terms
                .entry(term)
                .and_modify(|old| *old = (*old).min(rank))
                .or_insert(rank);
        }
    }
    let mut insert = transaction.prepare_cached(
        "INSERT INTO indexed_file_short_terms (term, rank, modified_order, file_id) VALUES (?1, ?2, ?3, ?4)",
    ).map_err(|_| storage_error())?;
    for (term, rank) in terms {
        insert
            .execute(params![term, rank, -modified_ms, id])
            .map_err(|_| storage_error())?;
    }
    Ok(())
}

impl MacFileIndex {
    pub(super) fn search(&self, input: FileSearchInput) -> Result<FileSearchPage, IndexError> {
        if input.query.len() > 1024 || input.query.contains('\0') {
            return Err(IndexError(
                "请输入不超过 1,024 字节的查找关键词。".to_owned(),
            ));
        }
        let query = normalized(input.query.trim());
        let config = self.configuration()?;
        let Some(config) = config else {
            return Ok(FileSearchPage {
                files: vec![],
                next_cursor: None,
                coverage: vec![],
            });
        };
        let policy = scan_policy(&config.rules);
        let mut roots = search_roots(config.roots, &policy);
        let mut files = Vec::new();
        let mut next_cursor = None;
        let mut position = Position {
            rank: -1,
            modified_order: 0,
            id: 0,
        };
        if let Some(cursor) = input.cursor {
            let cursor = (cursor.len() <= 8192)
                .then(|| serde_json::from_str::<SearchCursor>(&cursor).ok())
                .flatten()
                .filter(|cursor| cursor.query == query && cursor.generation == config.generation)
                .ok_or_else(|| IndexError(CURSOR_EXPIRED.to_owned()))?;
            position = cursor.position;
        }
        if !query.is_empty() && roots.iter().any(|root| root.device.is_some()) {
            let short = query.chars().take(3).count() < 3;
            let root_match = short
                && roots.iter().any(|root| {
                    let prefix = normalized(&root.coverage.path) + "/";
                    prefix.contains(&query)
                });
            let mut directories = BTreeMap::new();
            let mut last_visible = position;
            'pages: loop {
                let scoped_candidates = {
                    let connection = self.connection.lock().map_err(|_| storage_error())?;
                    store::check_generation(&connection, config.generation)?;
                    matching_candidates(&connection, &query, position, short, root_match)?
                        .into_iter()
                        .map(|candidate| {
                            let roots = store::covering_roots(
                                &connection,
                                &candidate.record.canonical_path,
                            )?;
                            Ok((candidate, roots))
                        })
                        .collect::<Result<Vec<_>, IndexError>>()?
                };
                let no_more = scoped_candidates.len() < CANDIDATE_BATCH as usize;
                for (candidate, committed_roots) in scoped_candidates {
                    position = candidate.position;
                    if !is_visible(
                        &candidate.record,
                        &committed_roots,
                        &policy,
                        &mut roots,
                        &mut directories,
                    ) {
                        continue;
                    }
                    if files.len() == PAGE_SIZE {
                        next_cursor = Some(
                            serde_json::to_string(&SearchCursor {
                                generation: config.generation,
                                query: query.clone(),
                                position: last_visible,
                            })
                            .map_err(|_| storage_error())?,
                        );
                        break 'pages;
                    }
                    last_visible = candidate.position;
                    let record = candidate.record;
                    files.push(FileSearchResult {
                        record_key: search_key(position.id, &record),
                        name: record
                            .canonical_path
                            .rsplit('/')
                            .next()
                            .unwrap_or_default()
                            .to_owned(),
                        path: record.canonical_path,
                        size_bytes: record.size_bytes,
                        modified_at_utc_ms: record.modified_at_utc_ms,
                    });
                }
                if no_more {
                    break;
                }
            }
        }
        let connection = self.connection.lock().map_err(|_| storage_error())?;
        store::check_generation(&connection, config.generation)?;
        Ok(FileSearchPage {
            files,
            next_cursor,
            coverage: roots.into_iter().map(|root| root.coverage).collect(),
        })
    }

    pub(super) fn resolve_search_record(&self, key: &str) -> Result<FileRecordInput, IndexError> {
        let stale = || IndexError(STALE.to_owned());
        let id: i64 = key
            .split_once(':')
            .and_then(|(id, _)| id.parse().ok())
            .ok_or_else(stale)?;
        let (config, record, committed_roots) = {
            let connection = self.connection.lock().map_err(|_| storage_error())?;
            let config = store::configuration(&connection)?.ok_or_else(stale)?;
            let record = connection.query_row(
                "SELECT path, identity, modified_ms, size_bytes FROM indexed_files WHERE rowid = ?1 AND search_path <> ''",
                [id], file_record,
            ).optional().map_err(|_| storage_error())?.ok_or_else(stale)?;
            let covered = store::covering_roots(&connection, &record.canonical_path)?;
            (config, record, covered)
        };
        let policy = scan_policy(&config.rules);
        let mut roots = search_roots(config.roots, &policy);
        if key != search_key(id, &record)
            || !is_visible(
                &record,
                &committed_roots,
                &policy,
                &mut roots,
                &mut BTreeMap::new(),
            )
            || !matches_file_identity(Path::new(&record.canonical_path), &record.file_identity)
        {
            return Err(stale());
        }
        let connection = self.connection.lock().map_err(|_| storage_error())?;
        store::check_generation(&connection, config.generation)?;
        Ok(record)
    }
}

fn matching_candidates(
    connection: &Connection,
    query: &str,
    position: Position,
    short: bool,
    root_match: bool,
) -> Result<Vec<SearchCandidate>, IndexError> {
    if short {
        let mut candidates = ranked_rows(connection,
            "SELECT f.path, f.identity, f.modified_ms, f.size_bytes, s.rank, s.modified_order, s.file_id
             FROM indexed_file_short_terms s JOIN indexed_files f ON f.rowid = s.file_id
             WHERE s.term = ?1 AND (s.rank, s.modified_order, s.file_id) > (?2, ?3, ?4) AND s.rank <= ?5
             ORDER BY s.rank, s.modified_order, s.file_id LIMIT ?6",
            params![query, position.rank, position.modified_order, position.id, if root_match { 1 } else { 2 }, CANDIDATE_BATCH],
        )?;
        let remaining = CANDIDATE_BATCH - candidates.len() as i64;
        if root_match && remaining > 0 {
            candidates.extend(text_rank_candidates(
                connection, query, position, 2, remaining, false,
            )?);
        }
        return Ok(candidates);
    }

    let mut candidates = Vec::new();
    if position.rank <= 0 {
        let (time, id) = after_in_rank(position, 0);
        candidates.extend(ranked_rows(connection,
            "SELECT path, identity, modified_ms, size_bytes, 0, -modified_ms, rowid
             FROM indexed_files WHERE search_name = ?1 AND modified_ms <= ?2 AND (modified_ms < ?2 OR rowid > ?3)
             ORDER BY modified_ms DESC, rowid LIMIT ?4",
            params![query, time, id, CANDIDATE_BATCH],
        )?);
    }
    for rank in position.rank.max(1)..=2 {
        let remaining = CANDIDATE_BATCH - candidates.len() as i64;
        if remaining == 0 {
            break;
        }
        candidates.extend(text_rank_candidates(
            connection, query, position, rank, remaining, true,
        )?);
    }
    Ok(candidates)
}

fn after_in_rank(position: Position, rank: i64) -> (i64, i64) {
    if position.rank == rank {
        (position.modified_order.saturating_neg(), position.id)
    } else {
        (i64::MAX, 0)
    }
}

fn text_rank_candidates(
    connection: &Connection,
    query: &str,
    position: Position,
    rank: i64,
    limit: i64,
    use_trigrams: bool,
) -> Result<Vec<SearchCandidate>, IndexError> {
    let (time, id) = after_in_rank(position, rank);
    // A recent ordered window can fill a whole page for common terms without
    // sorting every FTS hit. The trigram index handles sparse matches.
    let recent = ranked_rows(connection,
        "SELECT path, identity, modified_ms, size_bytes, ?1, -modified_ms, file_id FROM (
           SELECT path, identity, modified_ms, size_bytes, rowid AS file_id, search_name, search_path
           FROM indexed_files WHERE modified_ms <= ?3 AND (modified_ms < ?3 OR rowid > ?4)
           ORDER BY modified_ms DESC, rowid LIMIT 1024
         ) WHERE CASE WHEN ?1 = 1 THEN search_name != ?2 AND instr(search_name, ?2) > 0
                      ELSE instr(search_name, ?2) = 0 AND instr(search_path, ?2) > 0 END
         ORDER BY modified_ms DESC, file_id LIMIT ?5",
        params![rank, query, time, id, limit],
    )?;
    if recent.len() as i64 == limit {
        return Ok(recent);
    }
    if !use_trigrams {
        return ranked_rows(
            connection,
            "SELECT path, identity, modified_ms, size_bytes, 2, -modified_ms, rowid
             FROM indexed_files WHERE modified_ms <= ?2 AND (modified_ms < ?2 OR rowid > ?3)
               AND instr(search_name, ?1) = 0 AND instr(search_path, ?1) > 0
             ORDER BY modified_ms DESC, rowid LIMIT ?4",
            params![query, time, id, limit],
        );
    }
    let column = if rank == 1 {
        "search_name"
    } else {
        "search_path"
    };
    let literal_phrase = format!("{column} : \"{}\"", query.replace('"', "\"\""));
    ranked_rows(connection,
        "SELECT f.path, f.identity, f.modified_ms, f.size_bytes, ?1, -f.modified_ms, f.rowid
         FROM indexed_file_trigrams JOIN indexed_files f ON f.rowid = indexed_file_trigrams.rowid
         WHERE indexed_file_trigrams MATCH ?6 AND f.modified_ms <= ?3 AND (f.modified_ms < ?3 OR f.rowid > ?4)
           AND CASE WHEN ?1 = 1 THEN f.search_name != ?2 ELSE instr(f.search_name, ?2) = 0 END
         ORDER BY f.modified_ms DESC, f.rowid LIMIT ?5",
        params![rank, query, time, id, limit, literal_phrase],
    )
}

fn ranked_rows(
    connection: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<SearchCandidate>, IndexError> {
    let mut statement = connection
        .prepare_cached(sql)
        .map_err(|_| storage_error())?;
    let rows = statement
        .query_map(args, |row| {
            Ok(SearchCandidate {
                record: file_record(row)?,
                position: Position {
                    rank: row.get(4)?,
                    modified_order: row.get(5)?,
                    id: row.get(6)?,
                },
            })
        })
        .map_err(|_| storage_error())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| storage_error())
}

fn file_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileRecordInput> {
    Ok(FileRecordInput {
        canonical_path: row.get(0)?,
        file_identity: row.get(1)?,
        modified_at_utc_ms: row.get(2)?,
        size_bytes: row.get(3)?,
        source: MAC_INDEX_SOURCE.to_owned(),
    })
}

fn search_roots(roots: Vec<store::StoredRoot>, policy: &ScanPolicy) -> Vec<SearchRoot> {
    roots
        .into_iter()
        .filter_map(|root| {
            let path = Path::new(&root.path);
            if policy.macos_path_access(path) == MacPathAccess::Excluded {
                return None;
            }
            let (state, device) = match root_metadata(path, policy) {
                None => (MacRootState::Unavailable, None),
                Some(metadata)
                    if root
                        .identity
                        .as_ref()
                        .is_some_and(|identity| *identity != file_identity(&metadata)) =>
                {
                    (MacRootState::Building, None)
                }
                Some(metadata)
                    if matches!(root.state, MacRootState::Ready | MacRootState::Partial) =>
                {
                    (root.state, Some(metadata.dev()))
                }
                Some(_) => (root.state, None),
            };
            Some(SearchRoot {
                coverage: MacRootCoverage {
                    path: root.path,
                    state,
                },
                device,
                volume: root.volume,
            })
        })
        .collect()
}

fn is_visible(
    record: &FileRecordInput,
    committed_roots: &[String],
    policy: &ScanPolicy,
    roots: &mut [SearchRoot],
    directories: &mut BTreeMap<PathBuf, bool>,
) -> bool {
    if committed_roots.is_empty() {
        return false;
    }
    let path = Path::new(&record.canonical_path);
    let access = policy.macos_path_access(path);
    if access == MacPathAccess::Excluded {
        return false;
    }
    let metadata = fs::symlink_metadata(path).ok();
    let mut visible = false;
    for root in roots
        .iter_mut()
        .filter(|root| root.device.is_some() && committed_roots.contains(&root.coverage.path))
    {
        if access != MacPathAccess::Allowed
            || !can_list_parents(path, Path::new(&root.coverage.path), directories)
        {
            root.coverage.state = MacRootState::Partial;
            continue;
        }
        if let (Some(metadata), Some(volume)) = (&metadata, &root.volume)
            && metadata.is_file()
            && Some(metadata.dev()) == root.device
            && record.file_identity == format!("mac:{volume}:{}", inode_identity(metadata))
        {
            visible = true;
        }
    }
    visible && fs::canonicalize(path).is_ok_and(|canonical| canonical == path)
}

fn search_key(id: i64, record: &FileRecordInput) -> String {
    let mut hash = Sha256::new();
    hash.update(record.file_identity.as_bytes());
    hash.update([0]);
    hash.update(record.canonical_path.as_bytes());
    format!("{id}:{:x}", hash.finalize())
}
