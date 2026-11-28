use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    commands::settings::indexer_fields_changed,
    scan::configuration::{ScanRuleStore, ScanRules, validate_directory_group_threshold},
};

fn temporary_rules_path() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("qizhi-scan-rules-{nonce}.json"))
}

#[test]
#[cfg(not(target_os = "macos"))]
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

#[cfg(target_os = "macos")]
#[test]
fn reopening_an_explicitly_empty_macos_scan_scope_keeps_it_empty() {
    let temporary = tempfile::tempdir().expect("test directory");
    let path = temporary.path().join("scan-rules.json");
    let defaults = ScanRules {
        allowed_roots: vec![temporary.path().to_string_lossy().into_owned()],
        ..ScanRules::default()
    };
    ScanRuleStore::open(&path, defaults.clone())
        .expect("open rules")
        .save(ScanRules::default())
        .expect("save an empty scan scope");

    let rules = ScanRuleStore::open(&path, defaults)
        .expect("reopen rules")
        .get()
        .expect("read rules");
    assert!(rules.allowed_roots.is_empty());
    assert!(
        ScanRules::defaults_for_current_user()
            .allowed_roots
            .is_empty()
    );
}

#[test]
fn legacy_scan_rules_default_directory_group_threshold_to_five() {
    let path = temporary_rules_path();
    fs::write(
        &path,
        r#"{"allowedRoots":["D:\\Work"],"customExclusions":[],"fileCategories":["documents"]}"#,
    )
    .expect("write legacy rules");

    let rules = ScanRuleStore::open(&path, ScanRules::default())
        .expect("open legacy rules")
        .get()
        .expect("read legacy rules");

    assert_eq!(rules.directory_group_threshold, 5);
    fs::remove_file(path).expect("remove temporary rules");
}

#[test]
fn directory_group_threshold_accepts_documented_bounds() {
    assert_eq!(
        validate_directory_group_threshold(2).expect("lower bound"),
        2
    );
    assert_eq!(
        validate_directory_group_threshold(100).expect("upper bound"),
        100
    );
}

#[test]
fn directory_group_threshold_rejects_values_outside_documented_bounds() {
    assert!(validate_directory_group_threshold(1).is_err());
    assert!(validate_directory_group_threshold(101).is_err());
}

#[test]
fn threshold_only_change_does_not_reconfigure_the_indexer() {
    let previous = ScanRules {
        allowed_roots: vec![r"D:\Work".to_owned()],
        custom_exclusions: vec![r"D:\Work\Private".to_owned()],
        directory_group_threshold: 5,
        ..ScanRules::default()
    };
    let next = ScanRules {
        directory_group_threshold: 10,
        ..previous.clone()
    };

    assert!(!indexer_fields_changed(&previous, &next));

    let changed_roots = ScanRules {
        allowed_roots: vec![r"E:\Work".to_owned()],
        ..next
    };
    assert!(indexer_fields_changed(&previous, &changed_roots));
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
