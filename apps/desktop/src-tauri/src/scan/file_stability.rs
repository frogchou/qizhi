use std::path::Path;

/// Reject entries that vanished or changed after Everything returned them.
pub trait FileStability: Send + Sync {
    fn is_ready(&self, path: &Path, expected_size: i64) -> bool;
}

pub struct MetadataStability;

impl FileStability for MetadataStability {
    fn is_ready(&self, path: &Path, expected_size: i64) -> bool {
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.len() == expected_size as u64)
            .unwrap_or(false)
    }
}
