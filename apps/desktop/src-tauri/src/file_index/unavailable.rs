use crate::scan::configuration::ScanRules;

use super::{IndexError, IndexRefresh, IndexSnapshot, IndexStatus};

#[cfg(target_os = "macos")]
const NOT_AVAILABLE: &str = "此版本的 macOS 本地文件索引尚未启用。";
#[cfg(not(target_os = "macos"))]
const NOT_AVAILABLE: &str = "当前系统不支持本地文件索引。";

#[derive(Clone, Default)]
pub struct UnavailableFileIndex {}

impl UnavailableFileIndex {
    pub fn configure(&self, _: &ScanRules) -> Result<(), IndexError> {
        Ok(())
    }

    pub fn refresh_range(&self, _: IndexRefresh<'_>) -> Result<IndexSnapshot, IndexError> {
        Err(IndexError(NOT_AVAILABLE.to_owned()))
    }

    pub fn status(&self) -> IndexStatus {
        IndexStatus {
            available: false,
            message: NOT_AVAILABLE.to_owned(),
        }
    }
}
