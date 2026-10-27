use std::{path::Path, sync::Arc};

use qizhi_desktop_lib::{
    database::Database,
    discovery::port::{DiscoveredFile, DiscoveryHealth, FileDiscovery},
    scan::{
        file_stability::FileStability,
        policy::{AllowedRoot, ScanPolicy},
        service::ScanService,
    },
};

struct FakeDiscovery {
    files: Vec<DiscoveredFile>,
}

impl FileDiscovery for FakeDiscovery {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn health(&self) -> DiscoveryHealth {
        DiscoveryHealth {
            available: true,
            adapter: "fake".to_owned(),
            remediation: String::new(),
        }
    }
    fn find_modified_between(
        &self,
        _: &[AllowedRoot],
        _: i64,
        _: i64,
    ) -> Result<Vec<DiscoveredFile>, qizhi_desktop_lib::database::AppError> {
        Ok(self.files.clone())
    }
}

struct StableOnly(&'static str);
impl FileStability for StableOnly {
    fn is_ready(&self, path: &Path, _: i64) -> bool {
        path.to_string_lossy() == self.0
    }
}

#[test]
fn refreshes_today_once_skips_unsafe_or_changing_files_and_uses_half_open_day_range() {
    let database = Database::open(Path::new(":memory:")).expect("database");
    let working_root = std::env::current_dir().expect("work dir");
    let accepted = working_root
        .join("report.docx")
        .to_string_lossy()
        .to_string();
    std::fs::write(&accepted, b"0123456789").expect("accepted test file");
    let next_day = working_root
        .join("tomorrow.docx")
        .to_string_lossy()
        .to_string();
    let service = ScanService::new(
        Arc::new(FakeDiscovery {
            files: vec![
                DiscoveredFile {
                    path: accepted.clone(),
                    size_bytes: 10,
                    modified_at_utc_ms: 23_999,
                },
                DiscoveredFile {
                    path: accepted.clone(),
                    size_bytes: 10,
                    modified_at_utc_ms: 23_999,
                },
                DiscoveredFile {
                    path: next_day,
                    size_bytes: 10,
                    modified_at_utc_ms: 24_001,
                },
                DiscoveredFile {
                    path: r"C:\Windows\blocked.txt".to_owned(),
                    size_bytes: 10,
                    modified_at_utc_ms: 12_000,
                },
            ],
        }),
        ScanPolicy::new(vec![]),
        database.files(),
        Arc::new(StableOnly(Box::leak(accepted.clone().into_boxed_str()))),
    );

    let snapshot = service
        .refresh_for_range(vec![AllowedRoot(working_root)], 0, 24_000)
        .expect("refresh");

    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].canonical_path, accepted);
    assert_eq!(database.files().count().expect("count"), 1);
    assert_eq!(snapshot.skipped.len(), 2);
    assert_eq!(snapshot.clusters.len(), 1);
    let _ = std::fs::remove_file(accepted);
}
