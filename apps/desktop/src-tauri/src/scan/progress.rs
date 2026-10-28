use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayScanStatus {
    pub state: String,
    pub directories_scanned: usize,
    pub candidates_found: usize,
    pub started_at_utc_ms: Option<i64>,
    pub completed_at_utc_ms: Option<i64>,
    pub message: Option<String>,
}

impl Default for TodayScanStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_owned(),
            directories_scanned: 0,
            candidates_found: 0,
            started_at_utc_ms: None,
            completed_at_utc_ms: None,
            message: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct TodayScanProgress {
    status: Arc<Mutex<TodayScanStatus>>,
}

impl TodayScanProgress {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns false when another refresh is already running.
    pub fn start(&self) -> bool {
        let Ok(mut status) = self.status.lock() else {
            return false;
        };
        if status.state == "scanning" {
            return false;
        }
        *status = TodayScanStatus {
            state: "scanning".to_owned(),
            started_at_utc_ms: Some(Utc::now().timestamp_millis()),
            ..TodayScanStatus::default()
        };
        true
    }

    pub fn directory_scanned(&self) {
        if let Ok(mut status) = self.status.lock()
            && status.state == "scanning"
        {
            status.directories_scanned += 1;
        }
    }

    pub fn candidate_found(&self) {
        if let Ok(mut status) = self.status.lock()
            && status.state == "scanning"
        {
            status.candidates_found += 1;
        }
    }

    pub fn complete(&self) {
        if let Ok(mut status) = self.status.lock() {
            status.state = "completed".to_owned();
            status.completed_at_utc_ms = Some(Utc::now().timestamp_millis());
            status.message = None;
        }
    }

    pub fn fail(&self, message: &str) {
        if let Ok(mut status) = self.status.lock() {
            status.state = "failed".to_owned();
            status.completed_at_utc_ms = Some(Utc::now().timestamp_millis());
            status.message = Some(message.to_owned());
        }
    }

    pub fn snapshot(&self) -> TodayScanStatus {
        self.status.lock().map(|status| status.clone()).unwrap_or_else(|_| {
            TodayScanStatus {
                state: "failed".to_owned(),
                message: Some("无法读取扫描状态。".to_owned()),
                ..TodayScanStatus::default()
            }
        })
    }
}
