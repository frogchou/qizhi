use std::{path::Path, process::Command, sync::Arc};

use crate::{
    database::{AppError, repositories::FileRepository},
    scan::policy::ScanPolicy,
};

pub trait ProcessLauncher: Send + Sync {
    fn launch(&self, program: &str, args: &[String]) -> Result<(), AppError>;
}

pub struct WindowsProcessLauncher;

impl ProcessLauncher for WindowsProcessLauncher {
    fn launch(&self, program: &str, args: &[String]) -> Result<(), AppError> {
        Command::new(program)
            .args(args)
            .spawn()
            .map(|_| ())
            .map_err(|_| AppError::Storage)
    }
}

pub struct ExplorerLauncher {
    files: FileRepository,
    policy: ScanPolicy,
    process: Arc<dyn ProcessLauncher>,
}

impl ExplorerLauncher {
    pub fn new(
        files: FileRepository,
        policy: ScanPolicy,
        process: Arc<dyn ProcessLauncher>,
    ) -> Self {
        Self {
            files,
            policy,
            process,
        }
    }

    pub fn reveal(&self, file_id: i64) -> Result<(), AppError> {
        let file = self
            .files
            .get_by_id(file_id)?
            .ok_or(AppError::InvalidConfig)?;
        if !self.policy.is_allowed(Path::new(&file.canonical_path)) {
            return Err(AppError::InvalidConfig);
        }
        self.process.launch(
            "explorer.exe",
            &[format!("/select,{}", file.canonical_path)],
        )
    }
}
