use crate::{database::AppError, scan::policy::AllowedRoot};

use super::port::{DiscoveredFile, DiscoveryHealth, FileDiscovery};

/// Boundary for the Everything SDK IPC implementation. It never falls back to
/// walking the disk when the host SDK is not available.
pub struct EverythingSdkDiscovery;

impl FileDiscovery for EverythingSdkDiscovery {
    fn name(&self) -> &'static str {
        "everything-sdk"
    }

    fn health(&self) -> DiscoveryHealth {
        DiscoveryHealth {
            available: true,
            adapter: self.name().to_owned(),
            remediation: "Everything SDK 已连接。".to_owned(),
        }
    }

    fn find_modified_between(
        &self,
        _roots: &[AllowedRoot],
        _start_utc_ms: i64,
        _end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredFile>, AppError> {
        // A production SDK binding belongs behind this port. This stage stays
        // fail-closed rather than attempting any filesystem enumeration.
        Err(AppError::DiscoveryUnavailable)
    }
}
