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
        Path::new(r"C:\Users\Public\..\..\Windows"),
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

#[test]
fn only_allows_files_within_the_canonicalized_work_root() {
    let base = std::env::current_dir().expect("current project directory exists");
    let work_root = base.join(".qizhi-contained-work");
    let outside_root = base.join(".qizhi-outside-work");
    std::fs::create_dir_all(&work_root).expect("temporary root exists");
    std::fs::create_dir_all(&outside_root).expect("temporary outside root exists");
    let outside_file = outside_root.join("private.docx");
    std::fs::write(&outside_file, b"private").expect("outside test file");

    let bootstrap_policy = ScanPolicy::new(vec![]);
    let allowed = bootstrap_policy
        .validate_root(&work_root)
        .expect("valid work root");
    let policy = ScanPolicy::for_roots(vec![], vec![allowed]);
    assert!(!policy.is_allowed(&outside_file));
    assert!(policy.is_allowed_directory(&work_root));
    assert!(!policy.is_allowed_directory(&outside_root));

    let _ = std::fs::remove_file(outside_file);
    let _ = std::fs::remove_dir_all(work_root);
    let _ = std::fs::remove_dir_all(outside_root);
}

#[cfg(windows)]
#[test]
fn allows_a_normal_cached_path_under_an_extended_windows_scan_root() {
    let root = std::env::current_dir().expect("project directory");
    let extended_root = std::fs::canonicalize(&root).expect("canonical root");
    let policy = ScanPolicy::for_roots(
        vec![],
        vec![qizhi_desktop_lib::scan::policy::AllowedRoot(extended_root)],
    );

    assert!(policy.is_cached_path_allowed(&root.join("from-cache.md")));
}
