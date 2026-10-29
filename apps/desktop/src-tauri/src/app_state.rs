use crate::{
    database::Database,
    scan::{configuration::ScanRuleStore, progress::TodayScanProgress},
    telemetry::AppLogger,
};

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub scan_rules: ScanRuleStore,
    pub today_scan_progress: TodayScanProgress,
    pub logger: AppLogger,
}
