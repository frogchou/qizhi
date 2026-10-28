use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    discovery::{native_fs::NativeFileDiscovery, port::FileDiscovery},
    scan::policy::AllowedRoot,
};

fn milliseconds_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis()
        .try_into()
        .expect("millisecond timestamp fits i64")
}

fn test_root(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("native-discovery-tests")
        .join(name)
}

#[test]
fn finds_only_regular_files_modified_inside_the_requested_range() {
    let nonce = milliseconds_now();
    let root = test_root(&format!("qizhi-native-discovery-{nonce}"));
    fs::create_dir_all(root.join("folder")).expect("create test directory");
    fs::write(root.join("outside.txt"), "older").expect("write older file");
    thread::sleep(Duration::from_millis(25));
    let start = milliseconds_now();
    fs::write(root.join("inside.txt"), "current").expect("write current file");
    let end = milliseconds_now() + 1_000;
    let allowed_root = AllowedRoot(fs::canonicalize(&root).expect("canonical temporary root"));

    let found = NativeFileDiscovery::new(vec![])
        .find_modified_between(&[allowed_root], start, end)
        .expect("discover local files");

    assert_eq!(found.len(), 1);
    assert!(found[0].path.ends_with("inside.txt"));
    fs::remove_dir_all(root).expect("remove temporary directory");
}

#[test]
fn skips_custom_excluded_directories_during_discovery() {
    let nonce = milliseconds_now();
    let root = test_root(&format!("qizhi-native-exclusion-{nonce}"));
    let excluded = root.join("private");
    fs::create_dir_all(&excluded).expect("create excluded directory");
    let start = milliseconds_now() - 2_000;
    fs::write(root.join("work.txt"), "visible").expect("write visible file");
    fs::write(excluded.join("secret.txt"), "hidden").expect("write excluded file");
    let end = milliseconds_now() + 1_000;
    let allowed_root = AllowedRoot(fs::canonicalize(&root).expect("canonical temporary root"));

    let found = NativeFileDiscovery::new(vec![excluded])
        .find_modified_between(&[allowed_root], start, end)
        .expect("discover local files");

    assert_eq!(found.len(), 1);
    assert!(found[0].path.ends_with("work.txt"));
    fs::remove_dir_all(root).expect("remove temporary directory");
}
