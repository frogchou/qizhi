use serde::{Deserialize, Serialize};

pub const INDEXER_PIPE_NAME: &str = r"\\.\pipe\qizhi-ntfs-indexer-v1";
pub const INDEXER_PROTOCOL_VERSION: u16 = 1;
pub const MAX_IPC_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SCAN_ROOTS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IndexerRequestKind {
    Health,
    Configure {
        allowed_roots: Vec<String>,
        excluded_roots: Vec<String>,
        file_categories: Vec<crate::scan::file_filter::FileCategory>,
    },
    Build,
    Sync,
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
    MissingAuthorizedRoots,
}

impl IpcValidationError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::UnsupportedProtocol => "本地索引服务版本不兼容",
            Self::UnauthorizedCaller => "本地索引服务拒绝了当前 Windows 用户",
            Self::EmptyRequestId => "本地索引请求无效",
            Self::TooManyRoots => "扫描范围超过本地索引服务限制",
            Self::EmptyRoot | Self::MissingAuthorizedRoots => "扫描范围未获本地索引服务授权",
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
    match &request.kind {
        IndexerRequestKind::Health => return Ok(()),
        IndexerRequestKind::Configure { allowed_roots, .. } => {
            return validate_configured_roots(allowed_roots);
        }
        IndexerRequestKind::Build | IndexerRequestKind::Sync => {}
    }
    if policy.allowed_roots.is_empty() {
        return Err(IpcValidationError::MissingAuthorizedRoots);
    }
    Ok(())
}

pub fn validate_configured_roots(roots: &[String]) -> Result<(), IpcValidationError> {
    if roots.len() > MAX_SCAN_ROOTS {
        return Err(IpcValidationError::TooManyRoots);
    }
    if roots.iter().any(|root| root.trim().is_empty()) {
        return Err(IpcValidationError::EmptyRoot);
    }
    Ok(())
}
