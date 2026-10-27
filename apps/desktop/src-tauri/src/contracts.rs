#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRecordInput {
    pub canonical_path: String,
    pub file_identity: String,
    pub modified_at_utc_ms: i64,
    pub size_bytes: i64,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalDayRange {
    pub start_utc_ms: i64,
    pub next_start_utc_ms: i64,
}

impl LocalDayRange {
    pub fn new(start_utc_ms: i64, next_start_utc_ms: i64) -> Self {
        Self {
            start_utc_ms,
            next_start_utc_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRecord {
    pub id: i64,
    pub canonical_path: String,
    pub file_identity: String,
    pub modified_at_utc_ms: i64,
    pub size_bytes: i64,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskedServiceConfig {
    pub service: String,
    pub endpoint: String,
    pub api_key_mask: String,
    pub credential_reference: String,
}
