use crate::database::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Non-removable roots are denied before any local discovery call.
pub const LOCKED_EXCLUSIONS: &[&str] = &[
    r"C:\Windows",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\$Recycle.Bin",
];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRules {
    pub allowed_roots: Vec<String>,
    pub custom_exclusions: Vec<String>,
    pub es_cli_path: Option<String>,
}

impl ScanRules {
    pub fn locked_exclusions(&self) -> Vec<String> {
        LOCKED_EXCLUSIONS
            .iter()
            .map(|value| (*value).to_owned())
            .collect()
    }
}

#[derive(Clone)]
pub struct ScanRuleStore {
    path: PathBuf,
    rules: Arc<Mutex<ScanRules>>,
}

impl ScanRuleStore {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let rules = fs::read_to_string(path)
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default();
        Ok(Self {
            path: path.to_path_buf(),
            rules: Arc::new(Mutex::new(rules)),
        })
    }
    pub fn get(&self) -> Result<ScanRules, AppError> {
        self.rules
            .lock()
            .map(|value| value.clone())
            .map_err(|_| AppError::Storage)
    }
    pub fn save(&self, rules: ScanRules) -> Result<ScanRules, AppError> {
        let text = serde_json::to_string(&rules).map_err(|_| AppError::Storage)?;
        fs::write(&self.path, text).map_err(|_| AppError::Storage)?;
        *self.rules.lock().map_err(|_| AppError::Storage)? = rules.clone();
        Ok(rules)
    }
}
