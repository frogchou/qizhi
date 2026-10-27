use std::path::Path;

use qizhi_desktop_lib::scan::policy::ScanPolicy;

#[test]
fn rejects_system_network_and_excluded_paths_but_allows_a_work_directory() {
    let work_root = std::env::current_dir()
        .expect("current project directory exists")
        .join(".qizhi-allowed-work");
    std::fs::create_dir_all(&work_root).expect("temporary root exists");
    let policy = ScanPolicy::new(vec![work_root.join("private")]);

    for path in [
        Path::new(r"C:\Windows"),
        Path::new(r"C:\Program Files"),
        Path::new(r"C:\Users\example\AppData\Roaming"),
        Path::new(r"C:\$Recycle.Bin"),
        Path::new(r"\\server\share"),
        work_root.join("private").as_path(),
    ] {
        assert!(
            policy.validate_root(path).is_err(),
            "{path:?} must be rejected"
        );
    }

    assert!(policy.validate_root(&work_root).is_ok());
    let _ = std::fs::remove_dir_all(work_root);
}
