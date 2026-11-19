use std::{collections::HashSet, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileCategory {
    Documents,
    SourceCode,
    Images,
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
            || (self.categories.contains(&FileCategory::Images)
                && IMAGE_EXTENSIONS.contains(&extension.as_str()))
    }
}

/// Formats intentionally limited to artifacts with a defined downstream
/// action. Images are opt-in and upload to RAGFlow without entering text-only
/// JEV or summary extraction. Other media, executables, archives, and unknown
/// binaries remain outside the work discovery surface.
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx",
    "ods", "ppt", "pptx", "odp",
];

const SOURCE_CODE_EXTENSIONS: &[&str] = &[
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "html",
    "htm",
    "rs",
    "py",
    "js",
    "jsx",
    "ts",
    "tsx",
    "java",
    "kt",
    "kts",
    "go",
    "c",
    "h",
    "cc",
    "cpp",
    "cxx",
    "cs",
    "php",
    "rb",
    "swift",
    "scala",
    "sh",
    "ps1",
    "sql",
    "r",
    "lua",
    "dart",
    "vue",
    "svelte",
    "css",
    "scss",
    "less",
    "dockerfile",
    "gradle",
    "groovy",
];

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "tif", "tiff", "gif"];

#[cfg(test)]
mod tests {
    use super::{FileCategory, FileTypeFilter};
    use std::path::Path;

    #[test]
    fn documents_include_office_and_text_but_exclude_code_and_configuration() {
        let filter = FileTypeFilter::new(vec![FileCategory::Documents]);

        for path in [
            "report.docx",
            "sheet.xlsx",
            "slides.pptx",
            "note.txt",
            "readme.md",
        ] {
            assert!(
                filter.allows(Path::new(path)),
                "{path} should be a document"
            );
        }
        for path in ["package.json", "settings.toml", "main.rs", "report.py"] {
            assert!(!filter.allows(Path::new(path)), "{path} is not a document");
        }
    }

    #[test]
    fn source_code_includes_configuration_and_programming_files() {
        let filter = FileTypeFilter::new(vec![FileCategory::SourceCode]);

        for path in ["package.json", "settings.toml", "main.rs", "report.py"] {
            assert!(
                filter.allows(Path::new(path)),
                "{path} should be source code"
            );
        }
        assert!(!filter.allows(Path::new("report.docx")));
    }

    #[test]
    fn images_include_only_ragflow_compatible_common_formats() {
        let filter = FileTypeFilter::new(vec![FileCategory::Images]);

        for path in [
            "photo.jpg",
            "scan.JPEG",
            "diagram.png",
            "board.webp",
            "page.tif",
            "page.tiff",
            "animation.gif",
        ] {
            assert!(filter.allows(Path::new(path)), "{path} should be an image");
        }
        for path in [
            "report.docx",
            "main.rs",
            "photo.bmp",
            "vector.svg",
            "raw.cr2",
        ] {
            assert!(!filter.allows(Path::new(path)), "{path} is not supported");
        }
    }

    #[test]
    fn default_filter_keeps_image_discovery_disabled() {
        let filter = FileTypeFilter::default();

        assert!(!filter.allows(Path::new("photo.png")));
        assert!(filter.allows(Path::new("report.docx")));
        assert!(filter.allows(Path::new("main.rs")));
    }
}
