use crate::{database::AppError, scan::policy::AllowedRoot};

use super::port::{DiscoveredFile, DiscoveryHealth, FileDiscovery};

pub struct UnavailableDiscovery;

impl FileDiscovery for UnavailableDiscovery {
    fn name(&self) -> &'static str {
        "unavailable"
    }

    fn health(&self) -> DiscoveryHealth {
        DiscoveryHealth {
            available: false,
            adapter: self.name().to_owned(),
            remediation: "未检测到 Everything。请安装并启动 Everything，然后在设置中重新检测。"
                .to_owned(),
        }
    }

    fn find_modified_between(
        &self,
        _roots: &[AllowedRoot],
        _start_utc_ms: i64,
        _end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredFile>, AppError> {
        Err(AppError::DiscoveryUnavailable)
    }
}
