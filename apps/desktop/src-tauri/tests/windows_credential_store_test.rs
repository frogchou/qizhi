#![cfg(windows)]

use std::time::{SystemTime, UNIX_EPOCH};

use qizhi_desktop_lib::config::{SecretStore, secret_store::WindowsCredentialStore};

#[test]
#[ignore = "requires an interactive Windows Credential Manager user session"]
fn saves_and_reads_a_windows_credential_in_the_same_user_session() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let reference = format!("qizhi/test/credential-roundtrip-{nonce}");
    let store = WindowsCredentialStore;
    let _ = store.delete(&reference);

    store
        .put(&reference, "temporary-test-key")
        .expect("write Windows credential");
    assert_eq!(
        store.get(&reference).expect("read Windows credential"),
        "temporary-test-key"
    );
    store
        .delete(&reference)
        .expect("delete temporary Windows credential");
}

#[test]
fn links_the_native_windows_credential_backend() {
    let builder = std::any::type_name::<keyring::windows::WinCredentialBuilder>();
    assert!(builder.contains("WinCredentialBuilder"));
}
