use crate::database::AppError;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[derive(Clone, Debug)]
pub struct AllowedRoot(pub PathBuf);

pub struct ScanPolicy {
    exclusions: Vec<PathBuf>,
    allowed_roots: Vec<AllowedRoot>,
}

impl ScanPolicy {
    pub fn new(exclusions: Vec<PathBuf>) -> Self {
        Self {
            exclusions: normalized_exclusions(exclusions),
            allowed_roots: vec![],
        }
    }

    pub fn for_roots(exclusions: Vec<PathBuf>, allowed_roots: Vec<AllowedRoot>) -> Self {
        Self {
            exclusions: normalized_exclusions(exclusions),
            allowed_roots,
        }
    }

    pub fn validate_root(&self, path: &Path) -> Result<AllowedRoot, AppError> {
        if !path.is_absolute() || self.is_denied(path) || has_reparse_component(path) {
            return Err(AppError::InvalidConfig);
        }
        let canonical = std::fs::canonicalize(path).map_err(|_| AppError::InvalidConfig)?;
        if self.is_denied(&canonical) || has_reparse_component(&canonical) {
            return Err(AppError::InvalidConfig);
        }
        Ok(AllowedRoot(canonical))
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        let Ok(canonical) = self.validate_root(path) else {
            return false;
        };
        if !canonical.0.is_file() {
            return false;
        }
        self.allowed_roots.is_empty()
            || self
                .allowed_roots
                .iter()
                .any(|root| canonical.0.starts_with(&root.0))
    }

    /// Used while walking below an already approved root. It avoids resolving
    /// every directory again while still applying all locked and user-defined
    /// exclusions. Reparse points are handled by the walker from metadata.
    pub fn is_directory_denied(&self, path: &Path) -> bool {
        self.is_denied(path)
    }

    fn is_denied(&self, path: &Path) -> bool {
        let raw = path.to_string_lossy().to_ascii_lowercase();
        let value = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
        value.starts_with(r"\\")
            || [
                r"c:\windows",
                r"c:\program files",
                r"c:\program files (x86)",
                r"c:\$recycle.bin",
            ]
            .iter()
            .any(|prefix| is_path_prefix(value, prefix))
            || value.contains(r"\appdata\")
            || self.exclusions.iter().any(|excluded| {
                is_path_prefix(value, &excluded.to_string_lossy().to_ascii_lowercase())
            })
    }
}

fn normalized_exclusions(exclusions: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut normalized = Vec::new();
    for exclusion in exclusions {
        normalized.push(exclusion.clone());
        if let Ok(canonical) = std::fs::canonicalize(&exclusion)
            && !normalized.iter().any(|existing| existing == &canonical)
        {
            normalized.push(canonical);
        }
    }
    normalized
}

fn is_path_prefix(value: &str, prefix: &str) -> bool {
    value == prefix
        || value
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('\\') || suffix.starts_with('/'))
}

fn has_reparse_component(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        let Ok(metadata) = std::fs::symlink_metadata(ancestor) else {
            return true;
        };
        #[cfg(windows)]
        {
            metadata.file_attributes() & 0x0400 != 0
        }
        #[cfg(not(windows))]
        {
            metadata.file_type().is_symlink()
        }
    })
}
