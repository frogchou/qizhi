use std::path::PathBuf;

use crate::{database::AppError, scan::policy::AllowedRoot};

use super::{
    es_cli::EsCliDiscovery,
    everything_sdk::EverythingSdkDiscovery,
    port::{DiscoveredFile, DiscoveryHealth, FileDiscovery},
    unavailable::UnavailableDiscovery,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterAvailability {
    Available,
    Unavailable,
}

pub fn select_discovery(
    sdk: AdapterAvailability,
    cli: AdapterAvailability,
) -> Box<dyn FileDiscovery> {
    match (sdk, cli) {
        (AdapterAvailability::Available, _) => Box::new(EverythingSdkDiscovery::unconfigured()),
        (_, AdapterAvailability::Available) => Box::new(StaticCliDiscovery),
        _ => Box::new(UnavailableDiscovery),
    }
}

/// Builds the production fallback only from the user-selected executable path.
pub fn select_discovery_with_cli_path(
    sdk_available: bool,
    cli_path: Option<PathBuf>,
) -> Box<dyn FileDiscovery> {
    if sdk_available {
        Box::new(EverythingSdkDiscovery::unconfigured())
    } else if let Some(path) = cli_path.filter(|value| value.is_file()) {
        Box::new(EsCliDiscovery::new(path))
    } else {
        Box::new(UnavailableDiscovery)
    }
}

/// Uses the native SDK when its DLL was explicitly selected; otherwise falls
/// back to the separately configured `es.exe` command-line adapter.
pub fn select_discovery_with_paths(
    sdk_path: Option<PathBuf>,
    cli_path: Option<PathBuf>,
) -> Box<dyn FileDiscovery> {
    if let Some(path) = sdk_path.filter(|value| value.is_file()) {
        let sdk = EverythingSdkDiscovery::new(path);
        if sdk.health().available {
            return Box::new(sdk);
        }
    }
    if let Some(path) = cli_path.filter(|value| value.is_file()) {
        Box::new(EsCliDiscovery::new(path))
    } else {
        Box::new(UnavailableDiscovery)
    }
}

struct StaticCliDiscovery;

impl FileDiscovery for StaticCliDiscovery {
    fn name(&self) -> &'static str {
        "es-cli"
    }

    fn health(&self) -> DiscoveryHealth {
        DiscoveryHealth {
            available: true,
            adapter: self.name().to_owned(),
            remediation: "使用 Everything 命令行后备。".to_owned(),
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
