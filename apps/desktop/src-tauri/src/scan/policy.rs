use crate::database::AppError;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[derive(Clone, Debug)]
pub struct AllowedRoot(pub PathBuf);

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MacPathAccess {
    Allowed,
    Excluded,
    Unavailable,
}

pub struct ScanPolicy {
    exclusions: Vec<PathBuf>,
    #[cfg(target_os = "macos")]
    locked_exclusions: Vec<PathBuf>,
    #[cfg(target_os = "macos")]
    excluded_directories: Vec<(u64, u64)>,
    allowed_roots: Vec<AllowedRoot>,
    requires_allowed_root: bool,
}

impl ScanPolicy {
    pub fn new(exclusions: Vec<PathBuf>) -> Self {
        let mut policy = Self::for_roots(exclusions, vec![]);
        policy.requires_allowed_root = false;
        policy
    }

    pub fn for_roots(exclusions: Vec<PathBuf>, allowed_roots: Vec<AllowedRoot>) -> Self {
        let exclusions = normalized_exclusions(exclusions);
        #[cfg(target_os = "macos")]
        let locked_exclusions = crate::scan::configuration::macos_locked_exclusions();
        Self {
            #[cfg(target_os = "macos")]
            excluded_directories: excluded_directory_identities(&locked_exclusions, &exclusions),
            #[cfg(target_os = "macos")]
            locked_exclusions,
            exclusions,
            allowed_roots,
            requires_allowed_root: true,
        }
    }

    pub fn validate_root(&self, path: &Path) -> Result<AllowedRoot, AppError> {
        if !path.is_absolute() || self.is_denied(path) {
            return Err(AppError::InvalidConfig);
        }
        #[cfg(not(target_os = "macos"))]
        if has_reparse_component(path) {
            return Err(AppError::InvalidConfig);
        }
        let canonical = std::fs::canonicalize(path).map_err(|_| AppError::InvalidConfig)?;
        if self.is_denied(&canonical) {
            return Err(AppError::InvalidConfig);
        }
        #[cfg(not(target_os = "macos"))]
        if has_reparse_component(&canonical) {
            return Err(AppError::InvalidConfig);
        }
        Ok(AllowedRoot(canonical))
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        if !self.is_within_allowed_roots(path) {
            return false;
        }
        let Ok(canonical) = self.validate_root(path) else {
            return false;
        };
        if !canonical.0.is_file() {
            return false;
        }
        self.is_within_allowed_roots(&canonical.0)
    }

    pub fn is_allowed_record(&self, record: &crate::contracts::FileRecord) -> bool {
        let path = Path::new(&record.canonical_path);
        #[cfg(target_os = "macos")]
        if record.source == crate::file_index::macos::MAC_INDEX_SOURCE {
            return self.is_allowed_indexed_path(path, &record.file_identity);
        }
        self.is_allowed(path)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn is_allowed_indexed_path(&self, path: &Path, identity: &str) -> bool {
        let mut readable = std::collections::BTreeMap::new();
        self.is_allowed(path)
            && (!self.requires_allowed_root
                || self.allowed_roots.iter().any(|root| {
                    path.starts_with(&root.0)
                        && crate::file_index::macos::can_list_parents(path, &root.0, &mut readable)
                }))
            && crate::file_index::macos::matches_file_identity(path, identity)
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn open_record(
        &self,
        record: &crate::contracts::FileRecord,
    ) -> Result<std::fs::File, AppError> {
        self.open_verified_file(
            Path::new(&record.canonical_path),
            (record.source == crate::file_index::macos::MAC_INDEX_SOURCE)
                .then_some(record.file_identity.as_str()),
        )
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn open_verified_file(
        &self,
        path: &Path,
        identity: Option<&str>,
    ) -> Result<std::fs::File, AppError> {
        use std::os::unix::fs::OpenOptionsExt;

        if !identity.map_or_else(
            || self.is_allowed(path),
            |identity| self.is_allowed_indexed_path(path, identity),
        ) {
            return Err(AppError::InvalidConfig);
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| AppError::Storage)?;
        let metadata = file.metadata().map_err(|_| AppError::Storage)?;
        if !metadata.is_file()
            || identity.is_some_and(|identity| {
                !crate::file_index::macos::matches_indexed_metadata(path, &metadata, identity)
            })
        {
            return Err(AppError::InvalidConfig);
        }
        Ok(file)
    }

    pub fn is_allowed_directory(&self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        if !self.is_within_allowed_roots(path) {
            return false;
        }
        let Ok(canonical) = self.validate_root(path) else {
            return false;
        };
        if !canonical.0.is_dir() {
            return false;
        }
        self.is_within_allowed_roots(&canonical.0)
    }

    fn is_within_allowed_roots(&self, canonical: &Path) -> bool {
        !self.requires_allowed_root
            || self
                .allowed_roots
                .iter()
                .any(|root| canonical.starts_with(&root.0))
    }

    /// Applies the same privacy and scan-root boundary to an already stored
    /// file path. Unlike `is_allowed`, it does not require the file to still
    /// exist, so a rule change immediately hides old cached records.
    #[cfg(not(target_os = "macos"))]
    pub fn is_cached_path_allowed(&self, path: &Path) -> bool {
        self.is_windows_cached_path_allowed(path)
    }

    pub(crate) fn is_windows_cached_path_allowed(&self, path: &Path) -> bool {
        if self.is_windows_denied(path) {
            return false;
        }
        let value = comparable_path(path);
        !self.requires_allowed_root
            || self
                .allowed_roots
                .iter()
                .any(|root| is_path_prefix(&value, &comparable_path(&root.0)))
    }

    #[cfg(target_os = "macos")]
    pub fn is_cached_path_allowed(&self, path: &Path) -> bool {
        self.is_within_allowed_roots(path) && !self.is_denied(path)
    }

    /// Used while walking below an already approved root. It avoids resolving
    /// every directory again while still applying all locked and user-defined
    /// exclusions.
    pub fn is_directory_denied(&self, path: &Path) -> bool {
        self.is_denied(path)
    }

    #[cfg(not(target_os = "macos"))]
    fn is_denied(&self, path: &Path) -> bool {
        self.is_windows_denied(path)
    }

    fn is_windows_denied(&self, path: &Path) -> bool {
        let value = comparable_path(path);
        value.starts_with(r"\\")
            || [
                r"c:\windows",
                r"c:\program files",
                r"c:\program files (x86)",
                r"c:\$recycle.bin",
            ]
            .iter()
            .any(|prefix| is_path_prefix(&value, prefix))
            || value.contains(r"\appdata\")
            || self
                .exclusions
                .iter()
                .any(|excluded| is_path_prefix(&value, &comparable_path(excluded)))
    }

    #[cfg(target_os = "macos")]
    fn is_denied(&self, path: &Path) -> bool {
        self.macos_path_access(path) != MacPathAccess::Allowed
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn macos_path_access(&self, path: &Path) -> MacPathAccess {
        use std::{os::unix::fs::MetadataExt, path::Component};

        if !path.is_absolute()
            || path == Path::new("/")
            || path.components().any(|part| part == Component::ParentDir)
            || self
                .exclusions
                .iter()
                .chain(&self.locked_exclusions)
                .any(|excluded| path.starts_with(excluded))
        {
            return MacPathAccess::Excluded;
        }
        // Check parents before their children so even metadata lookups do not traverse a symlink.
        let mut ancestor = PathBuf::new();
        for part in path.components() {
            ancestor.push(part.as_os_str());
            match std::fs::symlink_metadata(&ancestor) {
                Ok(metadata)
                    if metadata.file_type().is_symlink()
                        || self
                            .excluded_directories
                            .contains(&(metadata.dev(), metadata.ino())) =>
                {
                    return MacPathAccess::Excluded;
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return MacPathAccess::Allowed;
                }
                Err(_) => return MacPathAccess::Unavailable,
            }
        }
        MacPathAccess::Allowed
    }
}

#[cfg(target_os = "macos")]
fn excluded_directory_identities(locked: &[PathBuf], exclusions: &[PathBuf]) -> Vec<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;

    // APFS may resolve different spellings to the same directory. Use its identity for existing exclusions.
    locked
        .iter()
        .chain(exclusions)
        .filter_map(|path| std::fs::symlink_metadata(path).ok())
        .filter(|metadata| metadata.is_dir())
        .map(|metadata| (metadata.dev(), metadata.ino()))
        .collect()
}

/// Validates configured roots without treating a user exclusion as an invalid
/// setting, then removes roots that are currently excluded. This preserves the
/// user's scan scope so removing the exclusion can reactivate it later.
pub fn active_roots(
    configured_roots: &[String],
    exclusions: &[PathBuf],
) -> Result<Vec<AllowedRoot>, AppError> {
    let validation_policy = ScanPolicy::new(vec![]);
    let roots = configured_roots
        .iter()
        .map(PathBuf::from)
        .map(|root| {
            let root = validation_policy.validate_root(&root)?;
            #[cfg(target_os = "macos")]
            if !root.0.is_dir() {
                return Err(AppError::InvalidConfig);
            }
            Ok(root)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let exclusion_policy = ScanPolicy::new(exclusions.to_vec());
    Ok(roots
        .into_iter()
        .filter(|root| !exclusion_policy.is_directory_denied(&root.0))
        .collect())
}

pub(crate) fn live_scan_roots(
    roots: &[String],
    exclusions: &[PathBuf],
) -> Result<Vec<AllowedRoot>, AppError> {
    #[cfg(target_os = "macos")]
    return Ok(roots
        .iter()
        .filter_map(|root| active_roots(std::slice::from_ref(root), exclusions).ok())
        .flatten()
        .collect());
    #[cfg(not(target_os = "macos"))]
    active_roots(roots, exclusions)
}

/// Converts a Windows extended-length path into the form users enter and see.
/// Windows filesystem APIs may canonicalize `C:\...` to `\\?\C:\...`; that
/// implementation detail must not leak into settings or boundary comparisons.
pub fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc_path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc_path}");
        }
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    }
    #[cfg(not(windows))]
    value.into_owned()
}

fn comparable_path(path: &Path) -> String {
    display_path(path)
        .replace('/', r"\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
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

#[cfg(not(target_os = "macos"))]
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

#[cfg(test)]
mod tests {
    use super::{ScanPolicy, active_roots, display_path};
    use std::path::{Path, PathBuf};

    #[test]
    fn a_root_bound_policy_with_no_active_roots_hides_cached_paths() {
        let policy = ScanPolicy::for_roots(vec![], vec![]);

        assert!(!policy.is_cached_path_allowed(Path::new(r"D:\\work\\notes.md")));
    }

    #[test]
    fn excluding_a_configured_root_deactivates_it_instead_of_invalidating_rules() {
        let root = std::env::current_dir().expect("current directory");
        let configured_roots = vec![display_path(&root)];
        let roots = active_roots(&configured_roots, &[PathBuf::from(&root)])
            .expect("a root exclusion remains a valid saved rule");

        assert!(roots.is_empty());
    }
}
