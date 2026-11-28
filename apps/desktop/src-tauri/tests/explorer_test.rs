use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use qizhi_desktop_lib::{
    contracts::FileRecordInput,
    database::Database,
    scan::policy::ScanPolicy,
    system::explorer::{ExplorerLauncher, ProcessLauncher},
};

#[derive(Default)]
struct FakeProcess(Mutex<Vec<(String, Vec<String>)>>);
impl ProcessLauncher for FakeProcess {
    fn launch(
        &self,
        program: &str,
        args: &[String],
    ) -> Result<(), qizhi_desktop_lib::database::AppError> {
        self.0
            .lock()
            .expect("lock")
            .push((program.to_owned(), args.to_vec()));
        Ok(())
    }
}

#[test]
fn reveals_only_a_persisted_allowed_file_using_an_argument_vector() {
    let database = Database::open(Path::new(":memory:")).expect("database");
    let directory = tempfile::tempdir().expect("test directory");
    let path = directory.path().canonicalize().unwrap().join("brief.docx");
    std::fs::write(&path, b"test").expect("test file");
    database
        .files()
        .upsert(&FileRecordInput {
            canonical_path: path.to_string_lossy().to_string(),
            file_identity: "brief".to_owned(),
            modified_at_utc_ms: 1,
            size_bytes: 2,
            source: "today".to_owned(),
        })
        .expect("save");
    let process = Arc::new(FakeProcess::default());
    let launcher =
        ExplorerLauncher::new(database.files(), ScanPolicy::new(vec![]), process.clone());

    launcher.reveal(1).expect("reveal saved file");
    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        process.0.lock().expect("lock").as_slice(),
        &[(
            "explorer.exe".to_owned(),
            vec![format!("/select,{}", path.to_string_lossy())]
        )]
    );
    #[cfg(target_os = "macos")]
    assert_eq!(
        process.0.lock().expect("lock").as_slice(),
        &[(
            "/usr/bin/open".to_owned(),
            vec!["-R".to_owned(), path.to_string_lossy().into_owned()]
        )]
    );
    assert!(launcher.reveal(999).is_err());
}

#[test]
fn opens_an_allowed_persisted_file_with_the_system_or_text_editor() {
    let database = Database::open(Path::new(":memory:")).expect("database");
    let directory = tempfile::tempdir().expect("test directory");
    let path = directory
        .path()
        .canonicalize()
        .unwrap()
        .join("qizhi-open-test.txt");
    std::fs::write(&path, b"test").expect("test file");
    database
        .files()
        .upsert(&FileRecordInput {
            canonical_path: path.to_string_lossy().to_string(),
            file_identity: "open-test".to_owned(),
            modified_at_utc_ms: 1,
            size_bytes: 4,
            source: "today".to_owned(),
        })
        .expect("save");
    let process = Arc::new(FakeProcess::default());
    let launcher =
        ExplorerLauncher::new(database.files(), ScanPolicy::new(vec![]), process.clone());

    launcher.open(1).expect("opens selected file");
    launcher
        .open_in_text_editor(1)
        .expect("opens with text editor");

    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        process.0.lock().expect("lock").as_slice(),
        &[
            (
                "explorer.exe".to_owned(),
                vec![path.to_string_lossy().to_string()]
            ),
            (
                "notepad.exe".to_owned(),
                vec![path.to_string_lossy().to_string()]
            ),
        ]
    );
    #[cfg(target_os = "macos")]
    assert_eq!(
        process.0.lock().expect("lock").as_slice(),
        &[
            (
                "/usr/bin/open".to_owned(),
                vec![path.to_string_lossy().into_owned()]
            ),
            (
                "/usr/bin/open".to_owned(),
                vec![
                    "-a".to_owned(),
                    "TextEdit".to_owned(),
                    path.to_string_lossy().into_owned()
                ]
            ),
        ]
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn deletes_only_a_persisted_allowed_file_and_forgets_its_record() {
    let database = Database::open(Path::new(":memory:")).expect("database");
    let path = std::env::current_dir()
        .expect("work dir")
        .join("qizhi-delete-test.txt");
    std::fs::write(&path, b"test").expect("test file");
    database
        .files()
        .upsert(&FileRecordInput {
            canonical_path: path.to_string_lossy().to_string(),
            file_identity: "delete-test".to_owned(),
            modified_at_utc_ms: 1,
            size_bytes: 4,
            source: "today".to_owned(),
        })
        .expect("save");
    let launcher = ExplorerLauncher::new(
        database.files(),
        ScanPolicy::new(vec![]),
        Arc::new(FakeProcess::default()),
    );

    launcher.delete(1).expect("deletes selected file");

    assert!(!path.exists());
    assert!(database.files().get_by_id(1).expect("read").is_none());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_file_actions_decline_an_old_record_after_the_file_is_replaced() {
    let database = Database::open(Path::new(":memory:")).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let path = root.join("报告.md");
    std::fs::write(&path, "new file").unwrap();
    database
        .files()
        .upsert(&FileRecordInput {
            canonical_path: path.to_string_lossy().into_owned(),
            file_identity: "mac:previous-volume:111:222".to_owned(),
            modified_at_utc_ms: 1,
            size_bytes: 6,
            source: qizhi_desktop_lib::file_index::macos::MAC_INDEX_SOURCE.to_owned(),
        })
        .unwrap();
    let process = Arc::new(FakeProcess::default());
    let launcher =
        ExplorerLauncher::new(database.files(), ScanPolicy::new(vec![]), process.clone());

    assert!(launcher.open(1).is_err());
    assert!(launcher.reveal(1).is_err());
    assert!(process.0.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new file");
}
