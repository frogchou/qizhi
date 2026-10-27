use crate::{database::Database, scan::configuration::ScanRuleStore};

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub scan_rules: ScanRuleStore,
}
