use crate::{
    database::AppError,
    scan::{
        file_filter::{FileCategory, default_file_categories},
        policy::{ScanPolicy, display_path},
    },
};
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRules {
    pub allowed_roots: Vec<String>,
    pub custom_exclusions: Vec<String>,
    #[serde(default = "default_file_categories")]
    pub file_categories: Vec<FileCategory>,
    pub everything_sdk_path: Option<String>,
    pub es_cli_path: Option<String>,
}

impl Default for ScanRules {
    fn default() -> Self {
        Self {
            allowed_roots: vec![],
            custom_exclusions: vec![],
            file_categories: default_file_categories(),
            everything_sdk_path: None,
            es_cli_path: None,
        }
    }
}

impl ScanRules {
    pub fn defaults_for_current_user() -> Self {
        let mut allowed_roots = Vec::new();
        if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
            for path in [
                profile.join("Desktop"),
                profile.join("Documents"),
                profile.join("Pictures"),
                profile,
            ] {
                if path.is_dir() {
                    allowed_roots.push(path.to_string_lossy().to_string());
                }
            }
        }
        allowed_roots.extend(non_system_drive_roots());
        allowed_roots.sort();
        allowed_roots.dedup();
        let policy = ScanPolicy::new(vec![]);
        allowed_roots.retain(|root| policy.validate_root(Path::new(root)).is_ok());
        Self {
            allowed_roots,
            ..Self::default()
        }
    }
    pub fn locked_exclusions(&self) -> Vec<String> {
        LOCKED_EXCLUSIONS
            .iter()
            .map(|value| (*value).to_owned())
            .collect()
    }

    fn normalize_user_paths(&mut self) {
        for path in self
            .allowed_roots
            .iter_mut()
            .chain(self.custom_exclusions.iter_mut())
        {
            *path = display_path(Path::new(path));
        }
    }
}

#[derive(Clone)]
pub struct ScanRuleStore {
    path: PathBuf,
    rules: Arc<Mutex<ScanRules>>,
}

impl ScanRuleStore {
    pub fn open(path: &Path, defaults: ScanRules) -> Result<Self, AppError> {
        let mut rules = fs::read_to_string(path)
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_else(|| defaults.clone());
        if rules.allowed_roots.is_empty() {
            rules.allowed_roots = defaults.allowed_roots;
        }
        let original_rules = rules.clone();
        rules.normalize_user_paths();
        if rules != original_rules {
            let text = serde_json::to_string(&rules).map_err(|_| AppError::Storage)?;
            fs::write(path, text).map_err(|_| AppError::Storage)?;
        }
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
    pub fn save(&self, mut rules: ScanRules) -> Result<ScanRules, AppError> {
        rules.normalize_user_paths();
        let text = serde_json::to_string(&rules).map_err(|_| AppError::Storage)?;
        fs::write(&self.path, text).map_err(|_| AppError::Storage)?;
        *self.rules.lock().map_err(|_| AppError::Storage)? = rules.clone();
        Ok(rules)
    }
}

#[cfg(windows)]
fn non_system_drive_roots() -> Vec<String> {
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
    }
    let mask = unsafe { GetLogicalDrives() };
    (0..26)
        .filter_map(|index| {
            let bit = 1_u32 << index;
            if mask & bit == 0 || index == 2 {
                return None;
            }
            let letter = char::from_u32(u32::from(b'A') + index)?;
            let root = format!("{letter}:\\");
            Path::new(&root).is_dir().then_some(root)
        })
        .collect()
}

#[cfg(not(windows))]
fn non_system_drive_roots() -> Vec<String> {
    vec![]
}
