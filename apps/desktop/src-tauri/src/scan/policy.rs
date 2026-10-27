use crate::database::AppError;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct AllowedRoot(pub PathBuf);

pub struct ScanPolicy {
    exclusions: Vec<PathBuf>,
}

impl ScanPolicy {
    pub fn new(exclusions: Vec<PathBuf>) -> Self {
        Self { exclusions }
    }
    pub fn validate_root(&self, path: &Path) -> Result<AllowedRoot, AppError> {
        let value = path.to_string_lossy().to_ascii_lowercase();
        if value.starts_with(r"\\")
            || [
                r"c:\windows",
                r"c:\program files",
                r"c:\program files (x86)",
                r"c:\$recycle.bin",
            ]
            .iter()
            .any(|prefix| value.starts_with(prefix))
            || value.contains(r"\appdata\")
            || self.exclusions.iter().any(|excluded| {
                path.to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with(&excluded.to_string_lossy().to_ascii_lowercase())
            })
        {
            return Err(AppError::InvalidConfig);
        }
        if std::fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(AppError::InvalidConfig);
        }
        Ok(AllowedRoot(path.to_path_buf()))
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        self.validate_root(path).is_ok()
    }
}
