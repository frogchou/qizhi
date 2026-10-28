use std::{
    fs, thread,
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

#[test]
fn finds_only_regular_files_modified_inside_the_requested_range() {
    let nonce = milliseconds_now();
    let root = std::env::temp_dir().join(format!("qizhi-native-discovery-{nonce}"));
    fs::create_dir_all(root.join("folder")).expect("create test directory");
    fs::write(root.join("outside.txt"), "older").expect("write older file");
    thread::sleep(Duration::from_millis(25));
    let start = milliseconds_now();
    fs::write(root.join("inside.txt"), "current").expect("write current file");
    let end = milliseconds_now() + 1_000;
    let allowed_root = AllowedRoot(fs::canonicalize(&root).expect("canonical temporary root"));

    let found = NativeFileDiscovery::new()
        .find_modified_between(&[allowed_root], start, end)
        .expect("discover local files");

    assert_eq!(found.len(), 1);
    assert!(found[0].path.ends_with("inside.txt"));
    fs::remove_dir_all(root).expect("remove temporary directory");
}
