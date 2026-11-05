use std::{
    io::{Cursor, Read},
    path::Path,
};

const MAX_FILE_CHARS: usize = 50_000;
const MAX_OFFICE_XML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PDF_INPUT_BYTES: usize = 12 * 1024 * 1024;

pub fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        _ => "text/plain",
    }
}

pub fn extract_summary_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|_| "无法读取文件内容。".to_owned())?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    extract_summary_text_from_bytes(&bytes, extension)
}

pub fn extract_summary_text_from_bytes(bytes: &[u8], extension: &str) -> Result<String, String> {
    let text = match extension.to_ascii_lowercase().as_str() {
        "pdf" => {
            if bytes.len() > MAX_PDF_INPUT_BYTES {
                return Err("PDF 过大，无法进行安全的本地回退。".to_owned());
            }
            pdf_extract::extract_text_from_mem(bytes)
                .map_err(|_| "无法解析 PDF 文本。".to_owned())?
        }
        "docx" => extract_zip(bytes, &["word/document.xml", "word/footnotes.xml"], &[])?,
        "pptx" => extract_zip(bytes, &[], &["ppt/slides/slide"])?,
        "xlsx" => extract_zip(bytes, &[], &["xl/sharedStrings.xml", "xl/worksheets/sheet"])?,
        "odt" | "ods" | "odp" => extract_zip(bytes, &["content.xml"], &[])?,
        "rtf" => extract_rtf(bytes)?,
        "doc" | "xls" | "ppt" => {
            return Err("旧版 Office 文件无法进行本地回退，请另存为新版格式。".to_owned());
        }
        _ => String::from_utf8(bytes.to_vec())
            .map_err(|_| "文件不是可安全解析的 UTF-8 文本。".to_owned())?,
    };
    let normalized = normalize_text(&text);
    if normalized.is_empty() {
        return Err("文件没有可用于总结的文本内容。".to_owned());
    }
    let total = normalized.chars().count();
    let mut bounded = normalized.chars().take(MAX_FILE_CHARS).collect::<String>();
    if total > MAX_FILE_CHARS {
        bounded.push_str("\n\n[内容已截断：该文件的本地回退文本达到安全长度上限]");
    }
    Ok(bounded)
}

fn extract_zip(bytes: &[u8], exact: &[&str], prefixes: &[&str]) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Office 文档格式无效。".to_owned())?;
    let mut names = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .and_then(|entry| entry.name().ok().map(|name| name.into_owned()))
        })
        .filter(|name| {
            exact.contains(&name.as_str()) || prefixes.iter().any(|prefix| name.starts_with(prefix))
        })
        .collect::<Vec<_>>();
    names.sort();
    let mut output = String::new();
    let mut remaining = MAX_OFFICE_XML_BYTES;
    for name in names {
        if remaining == 0 {
            break;
        }
        if let Ok(mut entry) = archive.by_name(&name) {
            let mut xml = String::new();
            let bytes_read = (&mut entry)
                .take(remaining)
                .read_to_string(&mut xml)
                .map_err(|_| "无法读取 Office 文档文本。".to_owned())?;
            remaining = remaining.saturating_sub(bytes_read as u64);
            let xml = xml
                .replace("</w:p>", "\n")
                .replace("</a:p>", "\n")
                .replace("</text:p>", "\n")
                .replace("</row>", "\n")
                .replace("</c>", "\t")
                .replace("</table:table-cell>", "\t");
            let mut inside = false;
            for character in xml.chars() {
                match character {
                    '<' => inside = true,
                    '>' => inside = false,
                    _ if !inside => output.push(character),
                    _ => {}
                }
            }
        }
    }
    Ok(output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">"))
}

fn normalize_text(text: &str) -> String {
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "");
    let mut output = String::with_capacity(normalized.len());
    let mut blank_lines = 0;
    for line in normalized.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_lines += 1;
            if blank_lines > 2 {
                continue;
            }
        } else {
            blank_lines = 0;
        }
        output.push_str(line);
        output.push('\n');
    }
    output.trim().to_owned()
}

fn extract_rtf(bytes: &[u8]) -> Result<String, String> {
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'}' => index += 1,
            b'\\' => {
                index += 1;
                if index >= bytes.len() {
                    break;
                }
                match bytes[index] {
                    b'\\' | b'{' | b'}' => {
                        output.push(bytes[index] as char);
                        index += 1;
                    }
                    b'\'' if index + 2 < bytes.len() => {
                        let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                        if let Some(value) =
                            hex.and_then(|value| u8::from_str_radix(value, 16).ok())
                        {
                            output.push(char::from(value));
                        }
                        index += 3;
                    }
                    value if value.is_ascii_alphabetic() => {
                        let start = index;
                        while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
                            index += 1;
                        }
                        let word = std::str::from_utf8(&bytes[start..index]).unwrap_or_default();
                        let number_start = index;
                        if index < bytes.len() && bytes[index] == b'-' {
                            index += 1;
                        }
                        while index < bytes.len() && bytes[index].is_ascii_digit() {
                            index += 1;
                        }
                        let number = std::str::from_utf8(&bytes[number_start..index])
                            .ok()
                            .and_then(|value| value.parse::<i32>().ok());
                        if index < bytes.len() && bytes[index] == b' ' {
                            index += 1;
                        }
                        match word {
                            "par" | "line" => output.push('\n'),
                            "tab" => output.push('\t'),
                            "u" => {
                                if let Some(value) = number {
                                    if let Some(character) =
                                        char::from_u32((value as i16 as u16) as u32)
                                    {
                                        output.push(character);
                                    }
                                    if index < bytes.len()
                                        && !matches!(bytes[index], b'\\' | b'{' | b'}')
                                    {
                                        index += 1;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => index += 1,
                }
            }
            value if value.is_ascii() => {
                output.push(value as char);
                index += 1;
            }
            _ => index += 1,
        }
        if output.chars().count() > MAX_FILE_CHARS + 1_000 {
            break;
        }
    }
    if output.trim().is_empty() {
        return Err("RTF 文件没有可用于总结的文本内容。".to_owned());
    }
    Ok(output)
}
