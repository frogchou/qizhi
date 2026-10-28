use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::scan::configuration::{ScanRuleStore, ScanRules};

fn temporary_rules_path() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("qizhi-scan-rules-{nonce}.json"))
}

#[test]
fn fills_default_roots_for_an_existing_empty_configuration() {
    let path = temporary_rules_path();
    fs::write(
        &path,
        r#"{"allowedRoots":[],"customExclusions":["D:\\Private"],"everythingSdkPath":null,"esCliPath":null}"#,
    )
    .expect("write existing rules");
    let defaults = ScanRules {
        allowed_roots: vec![r"D:\Work".to_owned()],
        ..ScanRules::default()
    };

    let rules = ScanRuleStore::open(&path, defaults)
        .expect("open store")
        .get()
        .expect("read rules");

    assert_eq!(rules.allowed_roots, vec![r"D:\Work"]);
    assert_eq!(rules.custom_exclusions, vec![r"D:\Private"]);
    fs::remove_file(path).expect("remove temporary rules");
}

#[cfg(windows)]
#[test]
fn migrates_windows_extended_paths_to_normal_user_paths() {
    let path = temporary_rules_path();
    let visible_path = std::env::current_dir()
        .expect("project directory")
        .to_string_lossy()
        .to_string();
    let extended_path = format!(r"\\?\{visible_path}");
    fs::write(
        &path,
        serde_json::json!({
            "allowedRoots": [extended_path],
            "customExclusions": [],
            "fileCategories": ["documents"],
            "everythingSdkPath": null,
            "esCliPath": null,
        })
        .to_string(),
    )
    .expect("write legacy rules");

    let rules = ScanRuleStore::open(&path, ScanRules::default())
        .expect("open store")
        .get()
        .expect("read rules");

    assert_eq!(rules.allowed_roots, vec![visible_path]);
    fs::remove_file(path).expect("remove temporary rules");
}
