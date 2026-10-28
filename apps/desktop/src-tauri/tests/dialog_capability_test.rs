#[test]
fn main_window_grants_the_directory_dialog_permission() {
    let capability = include_str!("../capabilities/default.json");

    assert!(
        capability.contains("dialog:default"),
        "the directory picker requires the dialog plugin permission"
    );
}
