use serde::{Deserialize, Serialize};

pub const INDEXER_PIPE_NAME: &str = r"\\.\pipe\qizhi-ntfs-indexer-v1";
pub const INDEXER_PROTOCOL_VERSION: u16 = 1;
pub const MAX_IPC_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SCAN_ROOTS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IndexerRequestKind {
    Health,
    Build { roots: Vec<String> },
    Sync { roots: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexerRequest {
    pub protocol_version: u16,
    pub request_id: String,
    pub kind: IndexerRequestKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexerResponse {
    pub protocol_version: u16,
    pub request_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IpcAuthorizationPolicy {
    pub caller_sid: String,
    pub allowed_roots: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IpcValidationError {
    UnsupportedProtocol,
    UnauthorizedCaller,
    EmptyRequestId,
    TooManyRoots,
    EmptyRoot,
    RootOutsidePolicy,
}

impl IpcValidationError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::UnsupportedProtocol => "本地索引服务版本不兼容",
            Self::UnauthorizedCaller => "本地索引服务拒绝了当前 Windows 用户",
            Self::EmptyRequestId => "本地索引请求无效",
            Self::TooManyRoots => "扫描范围超过本地索引服务限制",
            Self::EmptyRoot | Self::RootOutsidePolicy => "扫描范围未获本地索引服务授权",
        }
    }
}

pub fn validate_request(
    policy: &IpcAuthorizationPolicy,
    authenticated_sid: &str,
    request: &IndexerRequest,
) -> Result<(), IpcValidationError> {
    if request.protocol_version != INDEXER_PROTOCOL_VERSION {
        return Err(IpcValidationError::UnsupportedProtocol);
    }
    if policy.caller_sid != authenticated_sid {
        return Err(IpcValidationError::UnauthorizedCaller);
    }
    if request.request_id.trim().is_empty() {
        return Err(IpcValidationError::EmptyRequestId);
    }
    let roots = match &request.kind {
        IndexerRequestKind::Health => return Ok(()),
        IndexerRequestKind::Build { roots } | IndexerRequestKind::Sync { roots } => roots,
    };
    if roots.len() > MAX_SCAN_ROOTS {
        return Err(IpcValidationError::TooManyRoots);
    }
    if roots.iter().any(|root| root.trim().is_empty()) {
        return Err(IpcValidationError::EmptyRoot);
    }
    if roots
        .iter()
        .any(|root| !root_is_allowed(root, &policy.allowed_roots))
    {
        return Err(IpcValidationError::RootOutsidePolicy);
    }
    Ok(())
}

fn root_is_allowed(requested_root: &str, allowed_roots: &[String]) -> bool {
    let requested = normalize_root(requested_root);
    allowed_roots
        .iter()
        .map(|root| normalize_root(root))
        .any(|allowed| requested == allowed || requested.starts_with(&(allowed + "\\")))
}

fn normalize_root(value: &str) -> String {
    value
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}
