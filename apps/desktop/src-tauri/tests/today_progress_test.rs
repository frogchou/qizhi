use qizhi_desktop_lib::scan::progress::TodayScanProgress;

#[test]
fn progress_reports_scanning_counts_and_a_completed_terminal_state() {
    let progress = TodayScanProgress::new();
    assert!(progress.start());
    progress.directory_scanned();
    progress.directory_scanned();
    progress.candidate_found();

    let scanning = progress.snapshot();
    assert_eq!(scanning.state, "scanning");
    assert_eq!(scanning.directories_scanned, 2);
    assert_eq!(scanning.candidates_found, 1);

    progress.complete();
    let completed = progress.snapshot();
    assert_eq!(completed.state, "completed");
    assert!(completed.completed_at_utc_ms.is_some());
}
