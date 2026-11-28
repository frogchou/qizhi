use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{
    contracts::{FileRecordInput, LocalDayRange},
    scan::{file_filter::FileCategory, policy::AllowedRoot},
};

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(not(any(windows, target_os = "macos")))]
mod unavailable;
#[cfg(any(windows, test))]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::MacWorkspaceIndex as WorkspaceFileIndex;
#[cfg(not(any(windows, target_os = "macos")))]
pub use unavailable::UnavailableFileIndex as WorkspaceFileIndex;
#[cfg(windows)]
pub use windows::WindowsFileIndex as WorkspaceFileIndex;

#[derive(Clone, Copy)]
pub enum IndexPeriod {
    Today,
    Recent,
}

pub struct IndexRefresh<'a> {
    pub period: IndexPeriod,
    pub range: LocalDayRange,
    pub roots: &'a [AllowedRoot],
    pub exclusions: &'a [PathBuf],
    pub categories: &'a [FileCategory],
}

#[derive(Debug)]
pub struct IndexSnapshot {
    pub records: Vec<FileRecordInput>,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct IndexError(String);

#[derive(Serialize)]
pub struct IndexStatus {
    pub available: bool,
    pub message: String,
}

pub(crate) fn resolved_size_bytes(path: &Path, indexed_size: Option<i64>) -> i64 {
    if let Some(size) = indexed_size.filter(|size| *size > 0) {
        return size;
    }

    std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .and_then(|metadata| i64::try_from(metadata.len()).ok())
        .unwrap_or_else(|| indexed_size.unwrap_or_default().max(0))
}
