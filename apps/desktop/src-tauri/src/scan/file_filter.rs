use std::{collections::HashSet, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileCategory {
    Documents,
    SourceCode,
}

pub fn default_file_categories() -> Vec<FileCategory> {
    vec![FileCategory::Documents, FileCategory::SourceCode]
}

#[derive(Clone, Debug)]
pub struct FileTypeFilter {
    categories: HashSet<FileCategory>,
}

impl Default for FileTypeFilter {
    fn default() -> Self {
        Self::new(default_file_categories())
    }
}

impl FileTypeFilter {
    pub fn new(categories: Vec<FileCategory>) -> Self {
        Self {
            categories: categories.into_iter().collect(),
        }
    }

    pub fn allows(&self, path: &Path) -> bool {
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        let extension = extension.to_ascii_lowercase();
        (self.categories.contains(&FileCategory::Documents)
            && DOCUMENT_EXTENSIONS.contains(&extension.as_str()))
            || (self.categories.contains(&FileCategory::SourceCode)
                && SOURCE_CODE_EXTENSIONS.contains(&extension.as_str()))
    }
}

/// Formats intentionally limited to text, office, and source artifacts that
/// have a defined downstream extraction path. Media, executables, archives,
/// and unknown binaries remain outside the work discovery surface.
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "html", "htm",
    "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp",
];

const SOURCE_CODE_EXTENSIONS: &[&str] = &[
    "rs", "py", "js", "jsx", "ts", "tsx", "java", "kt", "kts", "go", "c", "h", "cc", "cpp",
    "cxx", "cs", "php", "rb", "swift", "scala", "sh", "ps1", "sql", "r", "lua", "dart", "vue",
    "svelte", "css", "scss", "less", "dockerfile", "gradle", "groovy",
];
