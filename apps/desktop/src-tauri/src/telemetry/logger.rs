use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use chrono::Local;
use serde::Serialize;

use super::redact_message;

/// Small, local-only diagnostic log. Logging is best-effort: inability to
/// write diagnostics must never stop a user workflow.
#[derive(Clone)]
pub struct AppLogger {
    directory: PathBuf,
}

#[derive(Serialize)]
struct LogEntry<'a> {
    timestamp: String,
    level: &'a str,
    component: &'a str,
    message: String,
}

impl AppLogger {
    pub fn new(data_dir: &Path) -> Self {
        let directory = data_dir.join("logs");
        let _ = fs::create_dir_all(&directory);
        Self { directory }
    }

    pub fn info(&self, component: &str, message: &str) {
        self.write("info", component, message);
    }

    pub fn error(&self, component: &str, message: &str) {
        self.write("error", component, message);
    }

    pub fn current_log_path(&self) -> PathBuf {
        self.directory
            .join(format!("qizhi-{}.log", Local::now().format("%Y-%m-%d")))
    }

    fn write(&self, level: &str, component: &str, message: &str) {
        let entry = LogEntry {
            timestamp: Local::now().to_rfc3339(),
            level,
            component,
            message: redact_message(message),
        };
        let Ok(serialized) = serde_json::to_string(&entry) else {
            return;
        };
        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.current_log_path())
        else {
            return;
        };
        let _ = writeln!(file, "{serialized}");
    }
}
