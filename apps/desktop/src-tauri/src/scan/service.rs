use std::{collections::BTreeMap, path::Path, sync::Arc};

use crate::{
    contracts::{
        FileRecord, FileRecordInput, LocalDayRange, ScanSkip, TodayCluster, TodaySnapshot,
    },
    database::{AppError, repositories::FileRepository},
    discovery::port::FileDiscovery,
};

use super::{
    file_stability::FileStability,
    policy::{AllowedRoot, ScanPolicy},
};

pub struct ScanService {
    discovery: Arc<dyn FileDiscovery>,
    policy: ScanPolicy,
    files: FileRepository,
    stability: Arc<dyn FileStability>,
}

impl ScanService {
    pub fn new(
        discovery: Arc<dyn FileDiscovery>,
        policy: ScanPolicy,
        files: FileRepository,
        stability: Arc<dyn FileStability>,
    ) -> Self {
        Self {
            discovery,
            policy,
            files,
            stability,
        }
    }

    pub fn refresh_for_range(
        &self,
        roots: Vec<AllowedRoot>,
        start_utc_ms: i64,
        next_start_utc_ms: i64,
    ) -> Result<TodaySnapshot, AppError> {
        let discovered =
            self.discovery
                .find_modified_between(&roots, start_utc_ms, next_start_utc_ms)?;
        let mut skipped = Vec::new();
        for item in discovered {
            let path = Path::new(&item.path);
            if item.modified_at_utc_ms < start_utc_ms
                || item.modified_at_utc_ms >= next_start_utc_ms
                || !self.policy.is_allowed(path)
            {
                skipped.push(ScanSkip {
                    reason: "文件不在允许的扫描范围内".to_owned(),
                });
                continue;
            }
            if !self.stability.is_ready(path, item.size_bytes) {
                skipped.push(ScanSkip {
                    reason: "文件仍在写入或已不可访问".to_owned(),
                });
                continue;
            }
            let canonical_path = item.path;
            let file_identity = canonical_path.to_ascii_lowercase();
            self.files.upsert(&FileRecordInput {
                canonical_path,
                file_identity,
                modified_at_utc_ms: item.modified_at_utc_ms,
                size_bytes: item.size_bytes,
                source: "本机文件".to_owned(),
            })?;
        }
        let files = self
            .files
            .list_for_local_day(LocalDayRange::new(start_utc_ms, next_start_utc_ms))?;
        Ok(TodaySnapshot {
            clusters: build_clusters(&files),
            files,
            skipped,
        })
    }
}

fn build_clusters(files: &[FileRecord]) -> Vec<TodayCluster> {
    let mut grouped: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for file in files {
        grouped
            .entry(file.source.clone())
            .or_default()
            .push(file.id);
    }
    grouped
        .into_iter()
        .map(|(label, file_ids)| TodayCluster { label, file_ids })
        .collect()
}
