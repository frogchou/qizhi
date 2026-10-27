use std::path::PathBuf;

/// Non-removable roots are denied before any local discovery call.
pub const LOCKED_EXCLUSIONS: &[&str] = &[
    r"C:\Windows",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\$Recycle.Bin",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanRules {
    pub allowed_roots: Vec<PathBuf>,
    pub custom_exclusions: Vec<PathBuf>,
}

impl ScanRules {
    pub fn locked_exclusions(&self) -> Vec<PathBuf> {
        LOCKED_EXCLUSIONS.iter().map(PathBuf::from).collect()
    }
}
