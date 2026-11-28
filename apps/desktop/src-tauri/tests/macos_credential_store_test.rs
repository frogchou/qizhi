#![cfg(target_os = "macos")]

use std::process::Command;

use qizhi_desktop_lib::config::{SecretStore, secret_store::SystemCredentialStore};

#[test]
#[ignore = "writes and deletes a unique test entry in the login Keychain"]
fn stores_a_test_credential_and_reads_it_in_a_new_process() {
    const REFERENCE_ENV: &str = "QIZHI_TEST_MAC_KEYCHAIN_REFERENCE";
    const VALUE: &str = "qizhi-ephemeral-test-credential";

    let store = SystemCredentialStore;
    if let Ok(reference) = std::env::var(REFERENCE_ENV) {
        assert!(reference.starts_with("qizhi/macos-smoke/"));
        assert!(store.get(&reference).is_ok_and(|value| value == VALUE));
        return;
    }

    let reference = format!("qizhi/macos-smoke/{}", uuid::Uuid::new_v4());
    assert!(!store.exists(&reference).expect("access the login Keychain"));
    store
        .put(&reference, VALUE)
        .expect("store the unique test credential");
    let child = Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--ignored",
            "--exact",
            "stores_a_test_credential_and_reads_it_in_a_new_process",
        ])
        .env(REFERENCE_ENV, &reference)
        .status();
    store
        .delete(&reference)
        .expect("clear the test Keychain item");
    assert!(
        !store
            .exists(&reference)
            .expect("check the cleaned reference")
    );
    assert!(child.is_ok_and(|status| status.success()));
}
