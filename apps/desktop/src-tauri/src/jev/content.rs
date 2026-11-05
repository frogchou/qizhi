use std::{fs::File, io::Read, path::Path};

use thiserror::Error;

const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MODEL_CHARS: usize = 16_000;
const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
const VALUE_DOCUMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "pdf", "doc", "docx", "odt", "rtf", "xls", "xlsx",
    "ods", "ppt", "pptx", "odp",
];

#[derive(Debug, Error)]
pub enum ExtractionError {
    #[error("unsupported document format: {0}")]
    UnsupportedFormat(String),
    #[error("target is not a regular file")]
    NotRegularFile,
    #[error("document is too large to extract safely")]
    TooLarge,
    #[error("document cannot be read")]
    Unreadable,
    #[error("document format is invalid")]
    InvalidFormat,
    #[error("document has no readable text")]
    Empty,
}

pub fn extract_value_text(path: &Path) -> Result<String, String> {
    let file_extension = extension(path);
    if !VALUE_DOCUMENT_EXTENSIONS.contains(&file_extension.as_str()) {
        return Err("JEV 仅分析文档与文本文件。".to_owned());
    }
    extract_document_text(path, MAX_MODEL_CHARS).map_err(|error| match error {
        ExtractionError::UnsupportedFormat(_) => {
            "暂不支持旧版 Office 二进制格式，请另存为新版格式。".to_owned()
        }
        ExtractionError::NotRegularFile => "目标不是普通文件。".to_owned(),
        ExtractionError::TooLarge => "文本文件超过自动评估大小限制。".to_owned(),
        ExtractionError::Unreadable => "无法读取文件内容。".to_owned(),
        ExtractionError::InvalidFormat => "无法解析文档文本。".to_owned(),
        ExtractionError::Empty => "文件没有可用于价值评估的文本内容。".to_owned(),
    })
}

pub fn extract_document_text(path: &Path, max_chars: usize) -> Result<String, ExtractionError> {
    let file_extension = extension(path);
    let metadata = std::fs::metadata(path).map_err(|_| ExtractionError::Unreadable)?;
    if !metadata.is_file() {
        return Err(ExtractionError::NotRegularFile);
    }
    let text = match file_extension.as_str() {
        "pdf" => pdf_extract::extract_text(path).map_err(|_| ExtractionError::InvalidFormat)?,
        "docx" => extract_ooxml(path, &["word/document.xml", "word/footnotes.xml"])?,
        "pptx" => extract_ooxml_prefixes(path, &["ppt/slides/slide"])?,
        "xlsx" => extract_ooxml_prefixes(path, &["xl/sharedStrings.xml", "xl/worksheets/sheet"])?,
        "doc" | "xls" | "ppt" => return Err(ExtractionError::UnsupportedFormat(file_extension)),
        "txt" | "md" | "markdown" | "csv" | "tsv" | "rtf" | "odt" | "ods" | "odp" => {
            extract_plain_text(path, metadata.len(), max_chars)?
        }
        _ => return Err(ExtractionError::UnsupportedFormat(file_extension)),
    };
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(ExtractionError::Empty);
    }
    Ok(normalized.chars().take(max_chars).collect())
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn extract_plain_text(
    path: &Path,
    length: u64,
    max_chars: usize,
) -> Result<String, ExtractionError> {
    let limit = MAX_SOURCE_BYTES.max((max_chars as u64).saturating_mul(4));
    if length > limit {
        return Err(ExtractionError::TooLarge);
    }
    let bytes = std::fs::read(path).map_err(|_| ExtractionError::Unreadable)?;
    String::from_utf8(bytes).map_err(|_| ExtractionError::InvalidFormat)
}

fn extract_ooxml(path: &Path, names: &[&str]) -> Result<String, ExtractionError> {
    let file = File::open(path).map_err(|_| ExtractionError::Unreadable)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| ExtractionError::InvalidFormat)?;
    let mut text = String::new();
    let mut expanded = 0_u64;
    for name in names {
        if let Ok(mut entry) = archive.by_name(name) {
            expanded = expanded.saturating_add(entry.size());
            ensure_archive_limit(expanded)?;
            append_xml_text(&mut entry, &mut text)?;
        }
    }
    Ok(text)
}

fn extract_ooxml_prefixes(path: &Path, prefixes: &[&str]) -> Result<String, ExtractionError> {
    let file = File::open(path).map_err(|_| ExtractionError::Unreadable)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| ExtractionError::InvalidFormat)?;
    let mut names = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .and_then(|entry| entry.name().ok().map(|name| name.into_owned()))
        })
        .filter(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)))
        .collect::<Vec<_>>();
    names.sort();
    let mut text = String::new();
    let mut expanded = 0_u64;
    for name in names {
        if let Ok(mut entry) = archive.by_name(&name) {
            expanded = expanded.saturating_add(entry.size());
            ensure_archive_limit(expanded)?;
            append_xml_text(&mut entry, &mut text)?;
        }
    }
    Ok(text)
}

fn ensure_archive_limit(expanded: u64) -> Result<(), ExtractionError> {
    if expanded > MAX_ARCHIVE_EXPANDED_BYTES {
        Err(ExtractionError::TooLarge)
    } else {
        Ok(())
    }
}

fn append_xml_text(reader: &mut impl Read, output: &mut String) -> Result<(), ExtractionError> {
    let mut xml = String::new();
    reader
        .read_to_string(&mut xml)
        .map_err(|_| ExtractionError::InvalidFormat)?;
    let mut inside_tag = false;
    let mut fragment = String::new();
    for character in xml.chars() {
        match character {
            '<' => {
                inside_tag = true;
                if !fragment.trim().is_empty() {
                    output.push_str(&decode_xml_entities(fragment.trim()));
                    output.push(' ');
                }
                fragment.clear();
            }
            '>' => inside_tag = false,
            _ if !inside_tag => fragment.push(character),
            _ => {}
        }
    }
    Ok(())
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}
