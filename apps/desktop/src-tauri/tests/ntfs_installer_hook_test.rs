#[test]
fn installer_runs_the_actual_bundled_executable_to_register_the_ntfs_service() {
    let hooks = include_str!("../windows/hooks.nsh");

    assert!(hooks.contains(r#""$INSTDIR\qizhi_desktop.exe" --install-ntfs-indexer-service"#));
    assert!(hooks.contains(r#""$INSTDIR\qizhi_desktop.exe" --uninstall-ntfs-indexer-service"#));
    assert!(!hooks.contains(r#""$INSTDIR\栖知.exe""#));
}
