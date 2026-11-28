mod client;
mod content;

pub use client::{JevClient, ValueDocument, ValueJudgment};
#[cfg(target_os = "macos")]
pub(crate) use content::extract_open_value_text;
pub use content::{ExtractionError, extract_document_text, extract_value_text};
