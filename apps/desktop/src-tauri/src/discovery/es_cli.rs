use std::{
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use crate::{database::AppError, scan::policy::AllowedRoot};

use super::port::{DiscoveredFile, DiscoveryHealth, FileDiscovery, parse_es_output};

pub const DEFAULT_RESULT_LIMIT: usize = 500;

pub struct EsCliDiscovery {
    executable: PathBuf,
    result_limit: usize,
}

impl EsCliDiscovery {
    pub fn new(executable: PathBuf) -> Self {
        Self {
            executable,
            result_limit: DEFAULT_RESULT_LIMIT,
        }
    }

    fn args_for_root(&self, root: &AllowedRoot) -> Vec<String> {
        vec![
            "-tsv".to_owned(),
            "-full-path".to_owned(),
            "-size".to_owned(),
            "-dm".to_owned(),
            "-date-format".to_owned(),
            "2".to_owned(),
            "-n".to_owned(),
            self.result_limit.to_string(),
            "-path".to_owned(),
            root.0.to_string_lossy().to_string(),
            "file:".to_owned(),
        ]
    }
}

impl FileDiscovery for EsCliDiscovery {
    fn name(&self) -> &'static str {
        "es-cli"
    }

    fn health(&self) -> DiscoveryHealth {
        DiscoveryHealth {
            available: self.executable.is_file(),
            adapter: self.name().to_owned(),
            remediation: if self.executable.is_file() {
                "使用 Everything 命令行后备。".to_owned()
            } else {
                "未找到 es.exe，请在设置中指定 Everything 命令行工具。".to_owned()
            },
        }
    }

    fn find_modified_between(
        &self,
        roots: &[AllowedRoot],
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredFile>, AppError> {
        if !self.executable.is_file() || start_utc_ms >= end_utc_ms {
            return Err(AppError::DiscoveryUnavailable);
        }
        let mut result = Vec::new();
        for root in roots {
            let mut child = Command::new(&self.executable)
                .args(self.args_for_root(root))
                .stdout(std::process::Stdio::piped())
                .spawn()
                .map_err(|_| AppError::DiscoveryUnavailable)?;
            let deadline = Instant::now() + Duration::from_secs(8);
            while child
                .try_wait()
                .map_err(|_| AppError::DiscoveryUnavailable)?
                .is_none()
            {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(AppError::DiscoveryUnavailable);
                }
                thread::sleep(Duration::from_millis(25));
            }
            let output = child
                .wait_with_output()
                .map_err(|_| AppError::DiscoveryUnavailable)?;
            if !output.status.success() {
                return Err(AppError::DiscoveryUnavailable);
            }
            let text =
                String::from_utf8(output.stdout).map_err(|_| AppError::DiscoveryInvalidData)?;
            result.extend(parse_es_output(&text)?.into_iter().filter_map(|mut item| {
                item.modified_at_utc_ms = filetime_to_unix_ms(item.modified_at_utc_ms)?;
                (item.modified_at_utc_ms >= start_utc_ms && item.modified_at_utc_ms < end_utc_ms)
                    .then_some(item)
            }));
            if result.len() >= self.result_limit {
                result.truncate(self.result_limit);
                break;
            }
        }
        Ok(result)
    }
}

fn filetime_to_unix_ms(filetime: i64) -> Option<i64> {
    filetime
        .checked_div(10_000)?
        .checked_sub(11_644_473_600_000)
}
