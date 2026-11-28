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

#[cfg(target_os = "macos")]
#[test]
fn cached_macos_paths_keep_component_boundaries_and_spelling() {
    use qizhi_desktop_lib::scan::policy::AllowedRoot;

    let root = Path::new("/Users/test/工作");
    let policy = ScanPolicy::for_roots(
        vec![root.join("Private"), root.join("分组")],
        vec![AllowedRoot(root.to_path_buf())],
    );

    assert!(policy.is_cached_path_allowed(&root.join("周报.md")));
    assert!(policy.is_cached_path_allowed(&root.join("private/笔记.md")));
    assert!(policy.is_cached_path_allowed(&root.join(r"分组\草稿.md")));
    assert!(!policy.is_cached_path_allowed(&root.join("Private/笔记.md")));
    assert!(!policy.is_cached_path_allowed(&root.join("分组/草稿.md")));
    assert!(!policy.is_cached_path_allowed(&root.join("../外部/草稿.md")));
    assert!(!policy.is_cached_path_allowed(Path::new("/Users/test/工作旧/草稿.md")));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_file_and_directory_checks_reject_symlinks_outside_work_root() {
    use std::{fs, os::unix::fs::symlink};

    let temporary = tempfile::tempdir().expect("test directory");
    let base = temporary
        .path()
        .canonicalize()
        .expect("canonical test directory");
    let root = base.join("工作");
    let outside = base.join("外部");
    fs::create_dir(&root).expect("create work directory");
    fs::create_dir(&outside).expect("create outside directory");
    fs::write(outside.join("笔记.md"), "private").expect("create outside file");
    fs::write(root.join("周报.md"), "work").expect("create allowed file");
    let link = root.join("链接");
    symlink(&outside, &link).expect("create test symlink");

    let allowed = ScanPolicy::new(vec![])
        .validate_root(&root)
        .expect("valid root");
    let policy = ScanPolicy::for_roots(vec![], vec![allowed]);
    assert!(policy.is_allowed(&root.join("周报.md")));
    assert!(!policy.is_allowed_directory(&link));
    assert!(!policy.is_allowed(&link.join("笔记.md")));
    assert!(!policy.is_cached_path_allowed(&link.join("笔记.md")));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_scan_scope_rejects_an_ordinary_file_as_a_root() {
    use qizhi_desktop_lib::scan::policy::{active_roots, display_path};

    let temporary = tempfile::tempdir().expect("test directory");
    let root = temporary
        .path()
        .canonicalize()
        .expect("canonical test directory");
    let file = root.join("笔记.md");
    std::fs::write(&file, "test").expect("create file");

    assert!(active_roots(&[display_path(&file)], &[]).is_err());
    assert!(active_roots(&[display_path(&root)], &[]).is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_scan_cannot_include_app_data_when_home_is_selected() {
    use qizhi_desktop_lib::scan::policy::AllowedRoot;

    let home = std::env::home_dir().expect("current user home");
    let policy = ScanPolicy::for_roots(vec![], vec![AllowedRoot(home.clone())]);
    assert!(!policy.is_cached_path_allowed(
        &home.join("Library/Application Support/com.qizhi.desktop/资料.md")
    ));
}

#[cfg(target_os = "macos")]
#[test]
fn exclusion_blocks_different_spellings_of_the_same_directory() {
    use std::fs;

    let temporary = tempfile::tempdir().expect("test directory");
    let root = temporary
        .path()
        .canonicalize()
        .expect("canonical test directory");
    fs::create_dir(root.join("Private")).expect("create excluded directory");
    fs::write(root.join("Private/notes.md"), "private").expect("create excluded file");
    let alias = root.join("private/notes.md");
    if !alias.is_file() {
        fs::create_dir(root.join("private")).expect("create separately spelled directory");
        fs::write(&alias, "work").expect("create allowed file");
    }
    let aliases_same_directory =
        fs::canonicalize(root.join("Private/notes.md")).ok() == fs::canonicalize(&alias).ok() || {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(root.join("Private")).unwrap().ino()
                == fs::metadata(root.join("private")).unwrap().ino()
        };
    let allowed = ScanPolicy::new(vec![])
        .validate_root(&root)
        .expect("valid root");
    let policy = ScanPolicy::for_roots(vec![root.join("Private")], vec![allowed]);

    assert_eq!(policy.is_allowed(&alias), !aliases_same_directory);
    assert_eq!(
        policy.is_cached_path_allowed(&alias),
        !aliases_same_directory
    );
}
