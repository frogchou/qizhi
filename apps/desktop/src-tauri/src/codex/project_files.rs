use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    codex::materials::{MaterialImportResult, MaterialImportStatus},
    jev::{ExtractionError, extract_document_text},
};

const LARGE_FILE_CONFIRMATION_BYTES: u64 = 50 * 1024 * 1024;
const CODEX_DERIVED_MAX_CHARS: usize = 500_000;
const CODEX_PLAIN_TEXT_MAX_BYTES: u64 = 4 * 1024 * 1024;
const EXTRACTABLE_DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "xlsx", "pptx", "txt", "md", "markdown", "csv", "tsv", "rtf", "odt", "ods",
    "odp",
];

#[derive(Debug, Error)]
pub enum ProjectFileError {
    #[error("invalid project id")]
    InvalidProjectId,
    #[error("unsafe project path")]
    UnsafePath,
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("file operation failed")]
    Io,
    #[error("document extraction failed")]
    Extraction,
    #[error("source changed after preview")]
    SourceChanged,
    #[error("large file confirmation required")]
    LargeFileConfirmationRequired,
    #[error("original-only confirmation required")]
    OriginalOnlyConfirmationRequired,
}

#[derive(Clone, Debug)]
pub struct ProjectLayout {
    pub root: PathBuf,
    pub materials_local: PathBuf,
    pub materials_ragflow: PathBuf,
    pub workspace: PathBuf,
    pub previews: PathBuf,
    pub staging: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ArtifactSnapshot {
    pub relative_path: PathBuf,
    pub size_bytes: u64,
    pub modified_at_utc_ms: i64,
    pub content_hash: String,
}

#[derive(Clone, Debug)]
pub struct HandoffFileSource {
    pub source_path: PathBuf,
    pub expected_size_bytes: u64,
    pub expected_modified_at_utc_ms: i64,
}

#[derive(Clone, Debug)]
pub struct StagedHandoffFile {
    pub source_path: PathBuf,
    pub original_path: PathBuf,
    pub derived_path: Option<PathBuf>,
    pub content_hash: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct CommittedHandoffFile {
    pub source_path: PathBuf,
    pub original_snapshot_path: PathBuf,
    pub derived_snapshot_path: Option<PathBuf>,
    pub content_hash: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct CodexProjectFiles {
    root: PathBuf,
}

impl CodexProjectFiles {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn create_layout(&self, project_id: &str) -> Result<ProjectLayout, ProjectFileError> {
        let root = self.project_root(project_id)?;
        let layout = ProjectLayout {
            materials_local: root.join("materials/local"),
            materials_ragflow: root.join("materials/ragflow"),
            workspace: root.join("workspace"),
            previews: root.join("previews"),
            staging: root.join(".staging"),
            root,
        };
        for directory in [
            &layout.materials_local,
            &layout.materials_ragflow,
            &layout.workspace,
            &layout.previews,
            &layout.staging,
        ] {
            fs::create_dir_all(directory).map_err(|_| ProjectFileError::Io)?;
        }
        Ok(layout)
    }

    pub fn resolve_material_path(
        &self,
        project_id: &str,
        relative: &Path,
    ) -> Result<PathBuf, ProjectFileError> {
        let layout = self.create_layout(project_id)?;
        resolve_beneath(&layout.root.join("materials"), relative)
    }

    pub fn resolve_workspace_path(
        &self,
        project_id: &str,
        relative: &Path,
    ) -> Result<PathBuf, ProjectFileError> {
        let layout = self.create_layout(project_id)?;
        resolve_beneath(&layout.workspace, relative)
    }

    pub fn snapshot_local_files(
        &self,
        project_id: &str,
        paths: &[PathBuf],
    ) -> Result<Vec<MaterialImportResult>, ProjectFileError> {
        self.snapshot_local_files_with_confirmation(project_id, paths, false)
    }

    pub fn snapshot_local_files_with_confirmation(
        &self,
        project_id: &str,
        paths: &[PathBuf],
        large_files_confirmed: bool,
    ) -> Result<Vec<MaterialImportResult>, ProjectFileError> {
        self.snapshot_local_files_with_confirmations(
            project_id,
            paths,
            large_files_confirmed,
            false,
        )
    }

    pub fn snapshot_local_files_with_confirmations(
        &self,
        project_id: &str,
        paths: &[PathBuf],
        large_files_confirmed: bool,
        original_only_confirmed: bool,
    ) -> Result<Vec<MaterialImportResult>, ProjectFileError> {
        let layout = self.create_layout(project_id)?;
        let mut results = Vec::with_capacity(paths.len());
        let mut known_hashes = hashes_in_directory(&layout.materials_local)?;
        for source in paths {
            ensure_regular_source(source)?;
            let metadata = fs::metadata(source).map_err(|_| ProjectFileError::Io)?;
            if metadata.len() > LARGE_FILE_CONFIRMATION_BYTES && !large_files_confirmed {
                results.push(MaterialImportResult {
                    source_path: source.clone(),
                    status: MaterialImportStatus::ConfirmationRequired,
                    original_snapshot_path: None,
                    derived_snapshot_path: None,
                    content_hash: None,
                    size_bytes: metadata.len(),
                });
                continue;
            }
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(extension.as_str(), "doc" | "xls" | "ppt") {
                return Err(ProjectFileError::UnsupportedFormat(extension));
            }
            let hash = sha256_file(source)?;
            if known_hashes.iter().any(|known| known == &hash) {
                results.push(MaterialImportResult {
                    source_path: source.clone(),
                    status: MaterialImportStatus::Duplicate,
                    original_snapshot_path: None,
                    derived_snapshot_path: None,
                    content_hash: Some(hash),
                    size_bytes: metadata.len(),
                });
                continue;
            }
            let original = unique_destination(&layout.materials_local, source, &hash);
            atomic_copy(source, &original)?;
            let text = match extract_document_text(source, CODEX_DERIVED_MAX_CHARS) {
                Ok(text) => Some(text),
                Err(ExtractionError::UnsupportedFormat(_))
                    if !EXTRACTABLE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) =>
                {
                    extract_utf8_project_text(source, metadata.len())?
                }
                Err(ExtractionError::Empty)
                    if !EXTRACTABLE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) =>
                {
                    None
                }
                Err(ExtractionError::UnsupportedFormat(_)) if original_only_confirmed => None,
                Err(ExtractionError::UnsupportedFormat(format)) => {
                    let _ = fs::remove_file(&original);
                    return Err(ProjectFileError::UnsupportedFormat(format));
                }
                Err(_) if original_only_confirmed => None,
                Err(_) => {
                    let _ = fs::remove_file(&original);
                    return Err(ProjectFileError::Extraction);
                }
            };
            let derived = if let Some(text) = text {
                let file_name = original
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("material");
                let derived = original.with_file_name(format!("{file_name}.derived.md"));
                atomic_write(&derived, text.as_bytes())?;
                Some(derived)
            } else {
                None
            };
            known_hashes.push(hash.clone());
            results.push(MaterialImportResult {
                source_path: source.clone(),
                status: MaterialImportStatus::Imported,
                original_snapshot_path: Some(original),
                derived_snapshot_path: derived,
                content_hash: Some(hash),
                size_bytes: metadata.len(),
            });
        }
        Ok(results)
    }

    pub fn stage_handoff_files(
        &self,
        project_id: &str,
        staging_id: &str,
        sources: &[HandoffFileSource],
        confirm_large_files: bool,
        confirm_original_only: bool,
    ) -> Result<Vec<StagedHandoffFile>, ProjectFileError> {
        Uuid::parse_str(staging_id).map_err(|_| ProjectFileError::UnsafePath)?;
        let layout = self.create_layout(project_id)?;
        let staging = layout.staging.join(staging_id);
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|_| ProjectFileError::Io)?;
        }
        fs::create_dir_all(&staging).map_err(|_| ProjectFileError::Io)?;
        let result = (|| {
            let mut staged = Vec::with_capacity(sources.len());
            for (index, source) in sources.iter().enumerate() {
                ensure_regular_source(&source.source_path)?;
                let before = fs::metadata(&source.source_path).map_err(|_| ProjectFileError::Io)?;
                if before.len() != source.expected_size_bytes
                    || metadata_modified_ms(&before) != source.expected_modified_at_utc_ms
                {
                    return Err(ProjectFileError::SourceChanged);
                }
                if before.len() > LARGE_FILE_CONFIRMATION_BYTES && !confirm_large_files {
                    return Err(ProjectFileError::LargeFileConfirmationRequired);
                }
                let extension = source
                    .source_path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if matches!(extension.as_str(), "doc" | "xls" | "ppt") {
                    return Err(ProjectFileError::UnsupportedFormat(extension));
                }
                let name = source
                    .source_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("material");
                let original = staging.join(format!("{index:04}-original-{name}"));
                atomic_copy(&source.source_path, &original)?;
                let after = fs::metadata(&source.source_path).map_err(|_| ProjectFileError::Io)?;
                if after.len() != before.len()
                    || metadata_modified_ms(&after) != metadata_modified_ms(&before)
                {
                    return Err(ProjectFileError::SourceChanged);
                }
                let hash = sha256_file(&original)?;
                let extraction =
                    extract_document_text(&source.source_path, CODEX_DERIVED_MAX_CHARS);
                let text = match extraction {
                    Ok(text) => Some(text),
                    Err(ExtractionError::UnsupportedFormat(_))
                        if !EXTRACTABLE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) =>
                    {
                        extract_utf8_project_text(&source.source_path, before.len())?
                    }
                    Err(ExtractionError::Empty)
                        if !EXTRACTABLE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) =>
                    {
                        None
                    }
                    Err(_) if EXTRACTABLE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()) => {
                        if confirm_original_only {
                            None
                        } else {
                            return Err(ProjectFileError::OriginalOnlyConfirmationRequired);
                        }
                    }
                    Err(ExtractionError::UnsupportedFormat(format)) => {
                        return Err(ProjectFileError::UnsupportedFormat(format));
                    }
                    Err(_) => return Err(ProjectFileError::Extraction),
                };
                let derived = text
                    .map(|text| {
                        let path = staging.join(format!("{index:04}-derived.md"));
                        atomic_write(&path, text.as_bytes())?;
                        Ok::<_, ProjectFileError>(path)
                    })
                    .transpose()?;
                staged.push(StagedHandoffFile {
                    source_path: source.source_path.clone(),
                    original_path: original,
                    derived_path: derived,
                    content_hash: hash,
                    size_bytes: before.len(),
                });
            }
            Ok(staged)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn commit_staged_handoff(
        &self,
        project_id: &str,
        staging_id: &str,
        staged: &[StagedHandoffFile],
    ) -> Result<Vec<CommittedHandoffFile>, ProjectFileError> {
        Uuid::parse_str(staging_id).map_err(|_| ProjectFileError::UnsafePath)?;
        let layout = self.create_layout(project_id)?;
        let expected_staging = layout.staging.join(staging_id);
        let mut committed = Vec::<CommittedHandoffFile>::with_capacity(staged.len());
        let result = (|| {
            for item in staged {
                if !item.original_path.starts_with(&expected_staging)
                    || item
                        .derived_path
                        .as_ref()
                        .is_some_and(|path| !path.starts_with(&expected_staging))
                {
                    return Err(ProjectFileError::UnsafePath);
                }
                let destination = unique_destination(
                    &layout.materials_local,
                    &item.source_path,
                    &item.content_hash,
                );
                fs::rename(&item.original_path, &destination).map_err(|_| ProjectFileError::Io)?;
                let derived_destination = if let Some(derived) = &item.derived_path {
                    let path = destination.with_file_name(format!(
                        "{}.derived.md",
                        destination
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("material")
                    ));
                    fs::rename(derived, &path).map_err(|_| ProjectFileError::Io)?;
                    Some(path)
                } else {
                    None
                };
                committed.push(CommittedHandoffFile {
                    source_path: item.source_path.clone(),
                    original_snapshot_path: destination,
                    derived_snapshot_path: derived_destination,
                    content_hash: item.content_hash.clone(),
                    size_bytes: item.size_bytes,
                });
            }
            Ok(committed.clone())
        })();
        if result.is_err() {
            for item in &committed {
                let _ = fs::remove_file(&item.original_snapshot_path);
                if let Some(path) = &item.derived_snapshot_path {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let _ = fs::remove_dir_all(expected_staging);
        result
    }

    pub fn discard_staging(
        &self,
        project_id: &str,
        staging_id: &str,
    ) -> Result<(), ProjectFileError> {
        Uuid::parse_str(staging_id).map_err(|_| ProjectFileError::UnsafePath)?;
        let layout = self.create_layout(project_id)?;
        let staging = layout.staging.join(staging_id);
        if staging.exists() {
            fs::remove_dir_all(staging).map_err(|_| ProjectFileError::Io)?;
        }
        Ok(())
    }

    pub fn scan_artifacts(
        &self,
        project_id: &str,
    ) -> Result<Vec<ArtifactSnapshot>, ProjectFileError> {
        let layout = self.create_layout(project_id)?;
        let mut artifacts = Vec::new();
        scan_directory(&layout.workspace, &layout.workspace, &mut artifacts)?;
        artifacts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(artifacts)
    }

    fn project_root(&self, project_id: &str) -> Result<PathBuf, ProjectFileError> {
        Uuid::parse_str(project_id).map_err(|_| ProjectFileError::InvalidProjectId)?;
        Ok(self.root.join(project_id))
    }
}

fn extract_utf8_project_text(
    source: &Path,
    size_bytes: u64,
) -> Result<Option<String>, ProjectFileError> {
    if size_bytes > CODEX_PLAIN_TEXT_MAX_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(source).map_err(|_| ProjectFileError::Io)?;
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(None);
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(text.chars().take(CODEX_DERIVED_MAX_CHARS).collect()))
}

fn resolve_beneath(base: &Path, relative: &Path) -> Result<PathBuf, ProjectFileError> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ProjectFileError::UnsafePath);
    }
    let joined = base.join(relative);
    if joined.exists() {
        ensure_no_reparse(&joined)?;
        let canonical_base = fs::canonicalize(base).map_err(|_| ProjectFileError::Io)?;
        let canonical = fs::canonicalize(&joined).map_err(|_| ProjectFileError::Io)?;
        if !canonical.starts_with(canonical_base) {
            return Err(ProjectFileError::UnsafePath);
        }
    }
    Ok(joined)
}

fn ensure_regular_source(path: &Path) -> Result<(), ProjectFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ProjectFileError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProjectFileError::UnsafePath);
    }
    ensure_no_reparse(path)
}

fn metadata_modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn ensure_no_reparse(path: &Path) -> Result<(), ProjectFileError> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let metadata = fs::symlink_metadata(path).map_err(|_| ProjectFileError::Io)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Err(ProjectFileError::UnsafePath)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn ensure_no_reparse(path: &Path) -> Result<(), ProjectFileError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ProjectFileError::Io)?;
    if metadata.file_type().is_symlink() {
        Err(ProjectFileError::UnsafePath)
    } else {
        Ok(())
    }
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), ProjectFileError> {
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::copy(source, &temporary).map_err(|_| ProjectFileError::Io)?;
    fs::rename(&temporary, destination).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        ProjectFileError::Io
    })
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), ProjectFileError> {
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = fs::File::create(&temporary).map_err(|_| ProjectFileError::Io)?;
    file.write_all(bytes).map_err(|_| ProjectFileError::Io)?;
    file.sync_all().map_err(|_| ProjectFileError::Io)?;
    fs::rename(&temporary, destination).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        ProjectFileError::Io
    })
}

fn sha256_file(path: &Path) -> Result<String, ProjectFileError> {
    let mut file = fs::File::open(path).map_err(|_| ProjectFileError::Io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| ProjectFileError::Io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hashes_in_directory(directory: &Path) -> Result<Vec<String>, ProjectFileError> {
    let mut hashes = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| ProjectFileError::Io)? {
        let path = entry.map_err(|_| ProjectFileError::Io)?.path();
        if path.is_file() && !path.to_string_lossy().ends_with(".derived.md") {
            hashes.push(sha256_file(&path)?);
        }
    }
    Ok(hashes)
}

fn unique_destination(directory: &Path, source: &Path, hash: &str) -> PathBuf {
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("material");
    let direct = directory.join(name);
    if !direct.exists() {
        return direct;
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("material");
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    directory.join(format!("{stem}-{}{extension}", &hash[..8]))
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    output: &mut Vec<ArtifactSnapshot>,
) -> Result<(), ProjectFileError> {
    for entry in fs::read_dir(directory).map_err(|_| ProjectFileError::Io)? {
        let entry = entry.map_err(|_| ProjectFileError::Io)?;
        let path = entry.path();
        ensure_no_reparse(&path)?;
        let metadata = entry.metadata().map_err(|_| ProjectFileError::Io)?;
        if metadata.is_dir() {
            scan_directory(root, &path, output)?;
        } else if metadata.is_file() {
            let relative_path = path
                .strip_prefix(root)
                .map_err(|_| ProjectFileError::UnsafePath)?
                .to_path_buf();
            let modified_at_utc_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            output.push(ArtifactSnapshot {
                relative_path,
                size_bytes: metadata.len(),
                modified_at_utc_ms,
                content_hash: sha256_file(&path)?,
            });
        }
    }
    Ok(())
}
