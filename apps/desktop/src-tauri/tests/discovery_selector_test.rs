use qizhi_desktop_lib::discovery::{
    AdapterAvailability, select_discovery, selector::select_discovery_with_paths,
};

#[test]
fn prefers_sdk_then_cli_then_an_unavailable_adapter_without_filesystem_fallback() {
    assert_eq!(
        select_discovery(
            AdapterAvailability::Available,
            AdapterAvailability::Available
        )
        .name(),
        "everything-sdk"
    );
    assert_eq!(
        select_discovery(
            AdapterAvailability::Unavailable,
            AdapterAvailability::Available
        )
        .name(),
        "es-cli"
    );
    let unavailable = select_discovery(
        AdapterAvailability::Unavailable,
        AdapterAvailability::Unavailable,
    );
    assert_eq!(unavailable.name(), "unavailable");
    assert!(unavailable.health().remediation.contains("Everything"));
}

#[test]
fn falls_back_to_cli_when_the_selected_sdk_dll_cannot_be_loaded() {
    let directory =
        std::env::temp_dir().join(format!("qizhi-selector-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temporary directory");
    let invalid_sdk = directory.join("Everything64.dll");
    let cli = directory.join("es.exe");
    std::fs::write(&invalid_sdk, b"not a dll").expect("invalid dll fixture");
    std::fs::write(&cli, b"not an executable").expect("cli fixture");

    let discovery = select_discovery_with_paths(Some(invalid_sdk.clone()), Some(cli.clone()));
    assert_eq!(discovery.name(), "es-cli");

    let _ = std::fs::remove_file(invalid_sdk);
    let _ = std::fs::remove_file(cli);
    let _ = std::fs::remove_dir_all(directory);
}
