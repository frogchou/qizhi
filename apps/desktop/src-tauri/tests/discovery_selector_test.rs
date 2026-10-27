use qizhi_desktop_lib::discovery::{AdapterAvailability, select_discovery};

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
