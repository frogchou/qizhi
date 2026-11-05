#[test]
fn installer_runs_the_actual_bundled_executable_to_register_the_ntfs_service() {
    let hooks = include_str!("../windows/hooks.nsh");

    assert!(hooks.contains(r#""$INSTDIR\qizhi_desktop.exe" --install-ntfs-indexer-service"#));
    assert!(hooks.contains(r#""$INSTDIR\qizhi_desktop.exe" --uninstall-ntfs-indexer-service"#));
    assert!(!hooks.contains(r#""$INSTDIR\栖知.exe""#));
}

#[test]
fn upgrading_restarts_an_already_running_indexer_service() {
    let source = include_str!("../src/ntfs/windows_service.rs");
    let install = source
        .split("fn install_service()")
        .nth(1)
        .expect("install function exists")
        .split("fn uninstall_service()")
        .next()
        .expect("install function body exists");

    assert!(install.contains("restart_service(service)"));
}

#[test]
fn installs_the_indexer_as_an_automatic_windows_service() {
    let source = include_str!("../src/ntfs/windows_service.rs");
    let install = source
        .split("fn install_service()")
        .nth(1)
        .expect("install function exists")
        .split("fn restart_service")
        .next()
        .expect("install function body exists");

    assert!(install.contains("SERVICE_AUTO_START"));
    assert!(!install.contains("SERVICE_DEMAND_START"));
}
