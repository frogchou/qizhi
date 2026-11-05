use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaterialImportStatus {
    Imported,
    Duplicate,
    ConfirmationRequired,
}

#[derive(Clone, Debug)]
pub struct MaterialImportResult {
    pub source_path: PathBuf,
    pub status: MaterialImportStatus,
    pub original_snapshot_path: Option<PathBuf>,
    pub derived_snapshot_path: Option<PathBuf>,
    pub content_hash: Option<String>,
    pub size_bytes: u64,
}
