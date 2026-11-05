mod client;
mod content;

pub use client::{JevClient, ValueDocument, ValueJudgment};
pub use content::{ExtractionError, extract_document_text, extract_value_text};
