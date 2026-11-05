use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, mpsc},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{
    codex::{
        AppServerNotification, AppServerProcess, CodexInstallationProbe, CodexInstallationState,
        CodexProjectFiles, CodexRuntimeError,
    },
    contracts::{CodexConversation, CodexProject},
    database::Database,
};

pub trait AppServerClient: Send + Sync {
    fn request(&self, method: &str, params: Value) -> Result<Value, CodexRuntimeError>;
    fn notify(&self, method: &str, params: Value) -> Result<(), CodexRuntimeError>;
    fn shutdown(&self);
    fn is_alive(&self) -> bool {
        true
    }
    fn subscribe(&self) -> mpsc::Receiver<AppServerNotification> {
        let (_, receiver) = mpsc::channel();
        receiver
    }
    fn respond(&self, _id: Value, _result: Value) -> Result<(), CodexRuntimeError> {
        Err(CodexRuntimeError::RequestFailed)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeStatus {
    pub installation: String,
    pub version: Option<String>,
    pub account: String,
    pub sandbox: String,
    pub server: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelOption {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    pub default_reasoning_effort: Option<String>,
    pub supported_reasoning_efforts: Vec<String>,
}

#[derive(Default)]
pub(crate) struct RuntimeState {
    pub(crate) client: Option<Arc<dyn AppServerClient>>,
    initialized: bool,
    cached_status: Option<CodexRuntimeStatus>,
    pub(crate) active_projects: HashMap<String, ActiveTurn>,
    pub(crate) starting_projects: HashSet<String>,
    pub(crate) uploading_projects: HashSet<String>,
    live_threads: HashSet<String>,
    pub(crate) resolved_approvals: HashSet<String>,
    pub(crate) pending_approvals: HashMap<String, PendingApproval>,
}

pub struct ArtifactUploadLease {
    state: Arc<Mutex<RuntimeState>>,
    project_id: String,
}

impl Drop for ArtifactUploadLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.uploading_projects.remove(&self.project_id);
        }
    }
}

#[derive(Clone)]
pub(crate) struct ActiveTurn {
    pub(crate) thread_id: String,
    pub(crate) codex_turn_id: String,
}

#[derive(Clone)]
pub(crate) struct PendingApproval {
    pub(crate) request_id: Value,
    pub(crate) project_id: String,
    pub(crate) conversation_id: String,
    pub(crate) local_turn_id: String,
    pub(crate) item_id: String,
    pub(crate) action_type: String,
    pub(crate) target_summary: String,
}

#[derive(Clone)]
pub struct CodexRuntime {
    pub(crate) database: Database,
    pub(crate) files: CodexProjectFiles,
    pub(crate) state: Arc<Mutex<RuntimeState>>,
}

impl CodexRuntime {
    pub fn project_files(&self) -> &CodexProjectFiles {
        &self.files
    }

    pub fn project_has_active_turn(&self, project_id: &str) -> bool {
        self.state
            .lock()
            .map(|state| {
                state.active_projects.contains_key(project_id)
                    || state.starting_projects.contains(project_id)
                    || state.uploading_projects.contains(project_id)
            })
            .unwrap_or(true)
            || self
                .database
                .codex()
                .project_has_active_turn(project_id)
                .unwrap_or(true)
    }

    pub fn reserve_artifact_upload(
        &self,
        project_id: &str,
    ) -> Result<ArtifactUploadLease, CodexRuntimeError> {
        self.reserve_project_mutation(project_id)
    }

    pub fn reserve_project_mutation(
        &self,
        project_id: &str,
    ) -> Result<ArtifactUploadLease, CodexRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?;
        if state.active_projects.contains_key(project_id)
            || state.starting_projects.contains(project_id)
            || state.uploading_projects.contains(project_id)
        {
            return Err(CodexRuntimeError::RequestFailed);
        }
        state.uploading_projects.insert(project_id.to_owned());
        drop(state);
        let lease = ArtifactUploadLease {
            state: self.state.clone(),
            project_id: project_id.to_owned(),
        };
        if self
            .database
            .codex()
            .project_has_active_turn(project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?
        {
            return Err(CodexRuntimeError::RequestFailed);
        }
        Ok(lease)
    }

    pub fn new(database: Database, files: CodexProjectFiles) -> Self {
        Self {
            database,
            files,
            state: Arc::new(Mutex::new(RuntimeState::default())),
        }
    }

    pub fn with_client(
        database: Database,
        files: CodexProjectFiles,
        client: Arc<dyn AppServerClient>,
    ) -> Self {
        Self {
            database,
            files,
            state: Arc::new(Mutex::new(RuntimeState {
                client: Some(client),
                initialized: false,
                cached_status: None,
                active_projects: HashMap::new(),
                starting_projects: HashSet::new(),
                uploading_projects: HashSet::new(),
                live_threads: HashSet::new(),
                resolved_approvals: HashSet::new(),
                pending_approvals: HashMap::new(),
            })),
        }
    }

    pub fn status(&self) -> Result<CodexRuntimeStatus, CodexRuntimeError> {
        if let Some(status) = self
            .state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .cached_status
            .clone()
        {
            return Ok(status);
        }
        let client = self.ensure_started()?;
        let account = client.request("account/read", json!({"refreshToken":false}))?;
        let sandbox = client.request("windowsSandbox/readiness", json!({}))?;
        let status = CodexRuntimeStatus {
            installation: "ready".to_owned(),
            version: CodexInstallationProbe::detect().version,
            account: if account.get("account").is_some_and(|value| !value.is_null())
                || account.get("requiresOpenaiAuth") == Some(&Value::Bool(false))
            {
                "ready"
            } else {
                "login_required"
            }
            .to_owned(),
            sandbox: sandbox
                .pointer("/status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            server: "ready".to_owned(),
        };
        self.state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .cached_status = Some(status.clone());
        Ok(status)
    }

    pub fn refresh_status(&self) -> Result<CodexRuntimeStatus, CodexRuntimeError> {
        self.state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .cached_status = None;
        self.status()
    }

    pub fn list_models(&self) -> Result<Vec<CodexModelOption>, CodexRuntimeError> {
        let response = self
            .ensure_started()?
            .request("model/list", json!({"limit":100,"includeHidden":false}))?;
        let models = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or(CodexRuntimeError::InvalidProtocol)?;
        Ok(models
            .iter()
            .filter_map(|model| {
                let id = model
                    .get("id")
                    .or_else(|| model.get("model"))?
                    .as_str()?
                    .to_owned();
                let efforts = model
                    .get("supportedReasoningEfforts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| {
                        effort
                            .get("reasoningEffort")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .collect();
                Some(CodexModelOption {
                    display_name: model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_owned(),
                    is_default: model
                        .get("isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    default_reasoning_effort: model
                        .get("defaultReasoningEffort")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    supported_reasoning_efforts: efforts,
                    id,
                })
            })
            .collect())
    }

    pub fn ensure_started(&self) -> Result<Arc<dyn AppServerClient>, CodexRuntimeError> {
        let existing_client = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| CodexRuntimeError::ProcessExited)?;
            if state
                .client
                .as_ref()
                .is_some_and(|client| !client.is_alive())
            {
                state.client = None;
                state.initialized = false;
                state.cached_status = None;
                state.live_threads.clear();
            }
            state.client.clone()
        };
        if let Some(client) = existing_client {
            self.initialize_if_needed(&client)?;
            return Ok(client);
        }
        match CodexInstallationProbe::detect().state {
            CodexInstallationState::Missing => return Err(CodexRuntimeError::NotInstalled),
            CodexInstallationState::Unsupported => {
                return Err(CodexRuntimeError::UnsupportedVersion);
            }
            CodexInstallationState::Ready => {}
        }
        let candidate: Arc<dyn AppServerClient> = Arc::new(AppServerProcess::spawn()?);
        let client = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| CodexRuntimeError::ProcessExited)?;
            if let Some(existing) = state.client.clone() {
                candidate.shutdown();
                existing
            } else {
                state.client = Some(candidate.clone());
                candidate
            }
        };
        self.initialize_if_needed(&client)?;
        Ok(client)
    }

    pub fn start_conversation_thread(
        &self,
        project_id: &str,
        conversation_id: &str,
        model: Option<&str>,
    ) -> Result<String, CodexRuntimeError> {
        let (project, conversation) =
            self.find_project_and_conversation(project_id, conversation_id)?;
        if let Some(thread_id) = conversation.codex_thread_id {
            if self
                .state
                .lock()
                .map_err(|_| CodexRuntimeError::ProcessExited)?
                .live_threads
                .contains(&thread_id)
            {
                return Ok(thread_id);
            }
            return self.resume_conversation_thread(project_id, conversation_id);
        }
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let workspace = layout.workspace.to_string_lossy().into_owned();
        let materials = layout.root.join("materials").to_string_lossy().into_owned();
        let response = self.ensure_started()?.request("thread/start", json!({
            "cwd": workspace,
            "model": model,
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "permissions": "qizhi-project",
            "runtimeWorkspaceRoots": [layout.root],
            "ephemeral": false,
            "developerInstructions": format!("这是栖知项目“{}”。只把 {} 中的内容视为用户选定的参考资料；不要修改这些资料。所有新文件和修改必须保存在当前 workspace。保留用户本机 Codex 的网络、MCP、Skills、插件和连接器能力，并在需要时按原生机制请求审批。", project.name, materials),
        }))?;
        let thread_id = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or(CodexRuntimeError::InvalidProtocol)?
            .to_owned();
        let session_id = response
            .pointer("/thread/sessionId")
            .and_then(Value::as_str)
            .unwrap_or(&thread_id)
            .to_owned();
        self.database
            .codex()
            .attach_thread(conversation_id, &thread_id, &session_id, now_ms())
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        self.state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .live_threads
            .insert(thread_id.clone());
        Ok(thread_id)
    }

    pub fn resume_conversation_thread(
        &self,
        project_id: &str,
        conversation_id: &str,
    ) -> Result<String, CodexRuntimeError> {
        let (_, conversation) = self.find_project_and_conversation(project_id, conversation_id)?;
        let thread_id = conversation
            .codex_thread_id
            .ok_or(CodexRuntimeError::RequestFailed)?;
        let layout = self
            .files
            .create_layout(project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let response = self.ensure_started()?.request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "cwd": layout.workspace,
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "permissions": "qizhi-project",
                "runtimeWorkspaceRoots": [layout.root],
                "excludeTurns": true
            }),
        )?;
        let resumed = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(CodexRuntimeError::InvalidProtocol)?;
        self.state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .live_threads
            .insert(resumed.clone());
        Ok(resumed)
    }

    pub fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(client) = state.client.take() {
                client.shutdown();
            }
            state.initialized = false;
            state.cached_status = None;
            state.live_threads.clear();
        }
    }

    pub(crate) fn force_stop_server(&self) {
        let client = self.state.lock().ok().and_then(|mut state| {
            state.initialized = false;
            state.cached_status = None;
            state.live_threads.clear();
            state.client.take()
        });
        if let Some(client) = client {
            client.shutdown();
        }
    }

    fn initialize_if_needed(
        &self,
        client: &Arc<dyn AppServerClient>,
    ) -> Result<(), CodexRuntimeError> {
        if self
            .state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .initialized
        {
            return Ok(());
        }
        client.request("initialize", json!({"clientInfo":{"name":"qizhi","title":"栖知","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true,"mcpServerOpenaiFormElicitation":true}}))?;
        client.notify("initialized", json!({}))?;
        self.state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .initialized = true;
        Ok(())
    }

    fn find_project_and_conversation(
        &self,
        project_id: &str,
        conversation_id: &str,
    ) -> Result<(CodexProject, CodexConversation), CodexRuntimeError> {
        let project = self
            .database
            .codex()
            .list_projects(false)
            .map_err(|_| CodexRuntimeError::RequestFailed)?
            .into_iter()
            .find(|value| value.id == project_id)
            .ok_or(CodexRuntimeError::RequestFailed)?;
        let conversation = self
            .database
            .codex()
            .list_conversations(project_id, true)
            .map_err(|_| CodexRuntimeError::RequestFailed)?
            .into_iter()
            .find(|value| value.id == conversation_id)
            .ok_or(CodexRuntimeError::RequestFailed)?;
        Ok((project, conversation))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}
