use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    database::AppError,
    scan::{
        file_filter::FileTypeFilter,
        policy::{AllowedRoot, ScanPolicy},
        progress::TodayScanProgress,
    },
};

use super::port::{DiscoveredFile, DiscoveryHealth, FileDiscovery};

const RESULT_LIMIT: usize = 500;

/// Discovers today's file metadata directly from user-approved local folders.
/// It never follows reparse points or descends into paths rejected by the
/// scan policy.
pub struct NativeFileDiscovery {
    directory_policy: ScanPolicy,
    progress: TodayScanProgress,
    file_filter: FileTypeFilter,
}

impl NativeFileDiscovery {
    pub fn new(exclusions: Vec<PathBuf>) -> Self {
        Self {
            directory_policy: ScanPolicy::new(exclusions),
            progress: TodayScanProgress::new(),
            file_filter: FileTypeFilter::default(),
        }
    }

    pub fn with_progress(
        exclusions: Vec<PathBuf>,
        progress: TodayScanProgress,
        file_filter: FileTypeFilter,
    ) -> Self {
        Self {
            directory_policy: ScanPolicy::new(exclusions),
            progress,
            file_filter,
        }
    }
}

impl FileDiscovery for NativeFileDiscovery {
    fn name(&self) -> &'static str {
        "native-file-system"
    }

    fn health(&self) -> DiscoveryHealth {
        DiscoveryHealth {
            available: true,
            adapter: self.name().to_owned(),
            remediation: "使用栖知本地文件发现。".to_owned(),
        }
    }

    fn find_modified_between(
        &self,
        roots: &[AllowedRoot],
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredFile>, AppError> {
        if start_utc_ms >= end_utc_ms {
            return Err(AppError::DiscoveryInvalidData);
        }
        let mut pending = roots
            .iter()
            .map(|root| root.0.clone())
            .collect::<Vec<PathBuf>>();
        let mut found = Vec::new();

        while let Some(directory) = pending.pop() {
            if self.directory_policy.is_directory_denied(&directory) {
                continue;
            }
            self.progress.directory_scanned();
            let entries = match fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                if is_reparse_point(&metadata) {
                    continue;
                }
                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                if !self.file_filter.allows(&path) {
                    continue;
                }
                let modified_at_utc_ms = match metadata.modified().ok().and_then(unix_milliseconds)
                {
                    Some(value) if value >= start_utc_ms && value < end_utc_ms => value,
                    _ => continue,
                };
                found.push(DiscoveredFile {
                    path: path.to_string_lossy().to_string(),
                    size_bytes: i64::try_from(metadata.len())
                        .map_err(|_| AppError::DiscoveryInvalidData)?,
                    modified_at_utc_ms,
                });
                self.progress.candidate_found();
                if found.len() > RESULT_LIMIT * 2 {
                    keep_newest(&mut found);
                }
            }
        }
        keep_newest(&mut found);
        Ok(found)
    }
}

fn unix_milliseconds(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn keep_newest(files: &mut Vec<DiscoveredFile>) {
    files.sort_by(|left, right| {
        right
            .modified_at_utc_ms
            .cmp(&left.modified_at_utc_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    files.truncate(RESULT_LIMIT);
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
