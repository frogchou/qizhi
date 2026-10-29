#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VolumeState {
    Ready,
    Building,
    Syncing,
    RebuildRequired,
    Unsupported,
    Unavailable,
    Failed,
}

impl VolumeState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Building => "building",
            Self::Syncing => "syncing",
            Self::RebuildRequired => "rebuild_required",
            Self::Unsupported => "unsupported",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "ready" => Some(Self::Ready),
            "building" => Some(Self::Building),
            "syncing" => Some(Self::Syncing),
            "rebuild_required" => Some(Self::RebuildRequired),
            "unsupported" => Some(Self::Unsupported),
            "unavailable" => Some(Self::Unavailable),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeDescriptor {
    pub volume_guid: String,
    pub current_mount_path: String,
    pub serial_number: Option<String>,
    pub file_system: String,
    pub state: VolumeState,
    pub state_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedVolume {
    pub id: i64,
    pub descriptor: VolumeDescriptor,
    pub last_indexed_at_utc_ms: Option<i64>,
    pub last_error_at_utc_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsnCheckpoint {
    pub usn_journal_id: String,
    pub next_usn: String,
    pub first_usn_seen: String,
    pub record_major_version: i64,
    pub last_successful_sync_at_utc_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexEntry {
    pub file_reference_number: String,
    pub parent_file_reference_number: Option<String>,
    pub name: String,
    pub is_directory: bool,
    pub file_attributes: i64,
    pub size_bytes: Option<i64>,
    pub modified_at_utc_ms: Option<i64>,
    pub last_usn: String,
    pub deleted_at_utc_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredEvent {
    pub file_reference_number: String,
    pub canonical_path: String,
    pub event_kind: String,
    pub modified_at_utc_ms: i64,
    pub size_bytes: Option<i64>,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexPage {
    pub volume_id: i64,
    pub entries: Vec<IndexEntry>,
    pub events: Vec<DiscoveredEvent>,
    pub checkpoint: UsnCheckpoint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexDiagnostic {
    pub volume_id: Option<i64>,
    pub code: String,
    pub message: String,
}

/// A caller-scoped index configuration owned by the privileged service.
/// The SID is derived from the connected named-pipe client, never supplied
/// as a trusted request field by the desktop application.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallerIndexPolicy {
    pub caller_sid: String,
    pub allowed_roots: Vec<String>,
    pub updated_at_utc_ms: i64,
}
