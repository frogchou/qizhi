use std::path::Path;

use qizhi_desktop_lib::codex::{CodexInstallationProbe, CodexInstallationState, CodexRuntimeError};

#[test]
fn reports_a_missing_codex_executable_without_exposing_an_os_error() {
    let status = CodexInstallationProbe::detect_at(Path::new("definitely-missing-qizhi-codex.exe"));
    assert_eq!(status.state, CodexInstallationState::Missing);
    assert!(status.version.is_none());
    assert!(status.remediation.contains("Codex"));
}

#[test]
fn runtime_errors_have_stable_user_facing_codes() {
    assert_eq!(
        CodexRuntimeError::NotInstalled.code(),
        "codex_not_installed"
    );
    assert_eq!(
        CodexRuntimeError::RequestTimeout.code(),
        "codex_request_timeout"
    );
    assert_eq!(
        CodexRuntimeError::ProcessExited.code(),
        "codex_process_exited"
    );
}
