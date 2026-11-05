use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use thiserror::Error;

use crate::codex::protocol::{JsonLineFramer, JsonRpcEnvelope};

const MAX_JSON_LINE_BYTES: usize = 8 * 1024 * 1024;
const QIZHI_PERMISSION_PROFILE: &str = r#"permissions={"qizhi-project"={description="Qizhi project workspace",filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="deny","materials"="read","workspace"="write","previews"="deny"}},network={enabled=true}}}"#;

#[derive(Clone, Debug, Error)]
pub enum CodexRuntimeError {
    #[error("Codex is not installed")]
    NotInstalled,
    #[error("Codex version is unsupported")]
    UnsupportedVersion,
    #[error("Codex process could not be started")]
    StartFailed,
    #[error("Codex process exited")]
    ProcessExited,
    #[error("Codex request timed out")]
    RequestTimeout,
    #[error("Codex protocol returned invalid data")]
    InvalidProtocol,
    #[error("Codex request failed")]
    RequestFailed,
    #[error("Codex request was rejected: {0}")]
    RequestRejected(String),
}

impl CodexRuntimeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotInstalled => "codex_not_installed",
            Self::UnsupportedVersion => "codex_unsupported_version",
            Self::StartFailed => "codex_start_failed",
            Self::ProcessExited => "codex_process_exited",
            Self::RequestTimeout => "codex_request_timeout",
            Self::InvalidProtocol => "codex_invalid_protocol",
            Self::RequestFailed => "codex_request_failed",
            Self::RequestRejected(_) => "codex_request_rejected",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexInstallationState {
    Ready,
    Missing,
    Unsupported,
}

#[derive(Clone, Debug)]
pub struct CodexInstallationStatus {
    pub state: CodexInstallationState,
    pub version: Option<String>,
    pub remediation: String,
}

pub struct CodexInstallationProbe;

impl CodexInstallationProbe {
    pub fn detect() -> CodexInstallationStatus {
        let Some((program, prefix)) = codex_invocation() else {
            return missing_installation();
        };
        Self::detect_command(&program, &prefix)
    }

    pub fn detect_at(executable: &Path) -> CodexInstallationStatus {
        Self::detect_command(executable, &[])
    }

    fn detect_command(executable: &Path, prefix: &[String]) -> CodexInstallationStatus {
        let mut command = Command::new(executable);
        command
            .args(prefix)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut command);
        match command.output() {
            Err(_) => missing_installation(),
            Ok(output) if !output.status.success() => CodexInstallationStatus {
                state: CodexInstallationState::Unsupported,
                version: None,
                remediation: "请更新 Codex 后重试。".to_owned(),
            },
            Ok(output) => {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if version.to_ascii_lowercase().contains("codex") {
                    CodexInstallationStatus {
                        state: CodexInstallationState::Ready,
                        version: Some(version),
                        remediation: String::new(),
                    }
                } else {
                    CodexInstallationStatus {
                        state: CodexInstallationState::Unsupported,
                        version: Some(version),
                        remediation: "当前命令不是受支持的 Codex，请检查安装。".to_owned(),
                    }
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct AppServerNotification {
    pub method: String,
    pub params: Value,
    pub request_id: Option<Value>,
}

type PendingSender = mpsc::SyncSender<Result<Value, CodexRuntimeError>>;

pub struct AppServerProcess {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, PendingSender>>>,
    subscribers: Arc<Mutex<Vec<mpsc::Sender<AppServerNotification>>>>,
    next_id: Mutex<u64>,
}

impl AppServerProcess {
    pub fn spawn() -> Result<Self, CodexRuntimeError> {
        let (program, mut arguments) = codex_invocation().ok_or(CodexRuntimeError::NotInstalled)?;
        arguments.extend([
            "-c".to_owned(),
            "default_permissions=\"qizhi-project\"".to_owned(),
            "-c".to_owned(),
            QIZHI_PERMISSION_PROFILE.to_owned(),
            "app-server".to_owned(),
            "--stdio".to_owned(),
        ]);
        let borrowed = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        Self::spawn_at(&program, &borrowed)
    }

    pub fn spawn_at(executable: &Path, arguments: &[&str]) -> Result<Self, CodexRuntimeError> {
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| CodexRuntimeError::StartFailed)?;
        let stdin = child.stdin.take().ok_or(CodexRuntimeError::StartFailed)?;
        let mut stdout = child.stdout.take().ok_or(CodexRuntimeError::StartFailed)?;
        let mut stderr = child.stderr.take().ok_or(CodexRuntimeError::StartFailed)?;
        let pending: Arc<Mutex<HashMap<u64, PendingSender>>> = Arc::new(Mutex::new(HashMap::new()));
        let subscribers = Arc::new(Mutex::new(Vec::<mpsc::Sender<AppServerNotification>>::new()));
        let reader_pending = Arc::clone(&pending);
        let reader_subscribers = Arc::clone(&subscribers);
        thread::spawn(move || {
            let mut framer = JsonLineFramer::new(MAX_JSON_LINE_BYTES);
            let mut buffer = [0_u8; 32 * 1024];
            loop {
                let read = match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let lines = match framer.push(&buffer[..read]) {
                    Ok(lines) => lines,
                    Err(_) => break,
                };
                for line in lines {
                    match JsonRpcEnvelope::parse(&line) {
                        Ok(JsonRpcEnvelope::Response { id, result, error }) => {
                            if let Some(sender) = reader_pending
                                .lock()
                                .ok()
                                .and_then(|mut values| values.remove(&id))
                            {
                                let value = if let Some(error) = error {
                                    let message = error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("request rejected")
                                        .chars()
                                        .take(500)
                                        .collect();
                                    Err(CodexRuntimeError::RequestRejected(message))
                                } else {
                                    Ok(result.unwrap_or(Value::Null))
                                };
                                let _ = sender.send(value);
                            }
                        }
                        Ok(JsonRpcEnvelope::Notification { method, params }) => publish(
                            &reader_subscribers,
                            AppServerNotification {
                                method,
                                params,
                                request_id: None,
                            },
                        ),
                        Ok(JsonRpcEnvelope::ServerRequest { id, method, params }) => publish(
                            &reader_subscribers,
                            AppServerNotification {
                                method,
                                params,
                                request_id: Some(id),
                            },
                        ),
                        Err(_) => {}
                    }
                }
            }
            fail_pending(&reader_pending, CodexRuntimeError::ProcessExited);
            if let Ok(mut values) = reader_subscribers.lock() {
                values.clear();
            }
        });
        thread::spawn(move || {
            let mut sink = std::io::sink();
            let _ = std::io::copy(&mut stderr, &mut sink);
        });
        Ok(Self {
            child: Mutex::new(child),
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            subscribers,
            next_id: Mutex::new(1),
        })
    }

    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CodexRuntimeError> {
        let id = {
            let mut next = self
                .next_id
                .lock()
                .map_err(|_| CodexRuntimeError::ProcessExited)?;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .insert(id, sender);
        if self
            .write_message(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .is_err()
        {
            self.pending
                .lock()
                .ok()
                .map(|mut values| values.remove(&id));
            return Err(CodexRuntimeError::ProcessExited);
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.pending
                    .lock()
                    .ok()
                    .map(|mut values| values.remove(&id));
                Err(CodexRuntimeError::RequestTimeout)
            }
            Err(_) => Err(CodexRuntimeError::ProcessExited),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), CodexRuntimeError> {
        self.write_message(&json!({"jsonrpc":"2.0","method":method,"params":params}))
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), CodexRuntimeError> {
        self.write_message(&json!({"jsonrpc":"2.0","id":id,"result":result}))
    }

    pub fn subscribe(&self) -> mpsc::Receiver<AppServerNotification> {
        let (sender, receiver) = mpsc::channel();
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.push(sender);
        }
        receiver
    }

    pub fn shutdown(&self) {
        let _ = self.notify("shutdown", Value::Null);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        fail_pending(&self.pending, CodexRuntimeError::ProcessExited);
    }

    pub fn is_alive(&self) -> bool {
        self.child
            .lock()
            .ok()
            .is_some_and(|mut child| child.try_wait().ok().flatten().is_none())
    }

    fn write_message(&self, value: &Value) -> Result<(), CodexRuntimeError> {
        let mut bytes =
            serde_json::to_vec(value).map_err(|_| CodexRuntimeError::InvalidProtocol)?;
        bytes.push(b'\n');
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?;
        stdin
            .write_all(&bytes)
            .and_then(|_| stdin.flush())
            .map_err(|_| CodexRuntimeError::ProcessExited)
    }
}

impl Drop for AppServerProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl crate::codex::runtime::AppServerClient for AppServerProcess {
    fn request(&self, method: &str, params: Value) -> Result<Value, CodexRuntimeError> {
        AppServerProcess::request(self, method, params, Duration::from_secs(120))
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), CodexRuntimeError> {
        AppServerProcess::notify(self, method, params)
    }

    fn shutdown(&self) {
        AppServerProcess::shutdown(self)
    }

    fn is_alive(&self) -> bool {
        AppServerProcess::is_alive(self)
    }

    fn subscribe(&self) -> mpsc::Receiver<AppServerNotification> {
        AppServerProcess::subscribe(self)
    }

    fn respond(&self, id: Value, result: Value) -> Result<(), CodexRuntimeError> {
        AppServerProcess::respond(self, id, result)
    }
}

fn publish(
    subscribers: &Arc<Mutex<Vec<mpsc::Sender<AppServerNotification>>>>,
    notification: AppServerNotification,
) {
    if let Ok(mut values) = subscribers.lock() {
        values.retain(|sender| sender.send(notification.clone()).is_ok());
    }
}

fn fail_pending(pending: &Arc<Mutex<HashMap<u64, PendingSender>>>, error: CodexRuntimeError) {
    if let Ok(mut values) = pending.lock() {
        for (_, sender) in values.drain() {
            let _ = sender.send(Err(error.clone()));
        }
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

fn missing_installation() -> CodexInstallationStatus {
    CodexInstallationStatus {
        state: CodexInstallationState::Missing,
        version: None,
        remediation: "请先安装 Codex，并确认可在本机正常运行。".to_owned(),
    }
}

#[cfg(windows)]
fn codex_invocation() -> Option<(std::path::PathBuf, Vec<String>)> {
    let app_data = std::env::var_os("APPDATA").map(std::path::PathBuf::from)?;
    let script = app_data.join("npm/node_modules/@openai/codex/bin/codex.js");
    if script.is_file()
        && let Some(node) = executable_on_path("node.exe")
    {
        return Some((node, vec![script.to_string_lossy().into_owned()]));
    }
    executable_on_path("codex.exe").map(|program| (program, Vec::new()))
}

#[cfg(not(windows))]
fn codex_invocation() -> Option<(std::path::PathBuf, Vec<String>)> {
    executable_on_path("codex").map(|program| (program, Vec::new()))
}

fn executable_on_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|path| path.join(name))
            .find(|candidate| candidate.is_file())
    })
}
