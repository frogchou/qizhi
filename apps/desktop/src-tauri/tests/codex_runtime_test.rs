use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    codex::{AppServerClient, CodexProjectFiles, CodexRuntime, CodexRuntimeError},
    database::Database,
};
use serde_json::{Value, json};

#[derive(Default)]
struct FakeClient {
    calls: Mutex<Vec<(String, Value)>>,
    responses: Mutex<HashMap<String, Vec<Value>>>,
}

impl FakeClient {
    fn respond(&self, method: &str, value: Value) {
        self.responses
            .lock()
            .unwrap()
            .entry(method.to_owned())
            .or_default()
            .push(value);
    }
    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

impl AppServerClient for FakeClient {
    fn request(&self, method: &str, params: Value) -> Result<Value, CodexRuntimeError> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        self.responses
            .lock()
            .unwrap()
            .get_mut(method)
            .and_then(|values| {
                if values.is_empty() {
                    None
                } else {
                    Some(values.remove(0))
                }
            })
            .ok_or(CodexRuntimeError::RequestFailed)
    }
    fn notify(&self, method: &str, params: Value) -> Result<(), CodexRuntimeError> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        Ok(())
    }
    fn shutdown(&self) {}
}

fn fixture(name: &str) -> (PathBuf, Database, CodexProjectFiles) {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("qizhi-codex-runtime-{name}-{nonce}"));
    std::fs::create_dir_all(&root).unwrap();
    let database = Database::open(&root.join("qizhi.db")).unwrap();
    let files = CodexProjectFiles::new(root.join("codex-projects"));
    (root, database, files)
}

#[test]
fn initializes_once_and_reports_the_reused_local_account_and_sandbox() {
    let (root, database, files) = fixture("status");
    let client = Arc::new(FakeClient::default());
    client.respond("initialize", json!({"userAgent":"codex"}));
    client.respond("account/read", json!({"account":{"type":"chatgpt","email":"person@example.com","planType":"plus"},"requiresOpenaiAuth":true}));
    client.respond("windowsSandbox/readiness", json!({"status":"ready"}));
    let runtime = CodexRuntime::with_client(database, files, client.clone());
    let status = runtime.status().expect("status");
    assert_eq!(status.account, "ready");
    assert_eq!(status.sandbox, "ready");
    assert_eq!(
        client
            .calls()
            .iter()
            .filter(|(method, _)| method == "initialize")
            .count(),
        1
    );
    runtime.status().expect("second status");
    assert_eq!(
        client
            .calls()
            .iter()
            .filter(|(method, _)| method == "initialize")
            .count(),
        1
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn starts_and_resumes_a_thread_in_the_project_workspace_with_material_guidance() {
    let (root, database, files) = fixture("thread");
    let project = database
        .codex()
        .create_project("年度报告", None, "managed", 10)
        .unwrap();
    let conversation = database
        .codex()
        .create_conversation(&project.id, "起草报告", 11)
        .unwrap();
    let client = Arc::new(FakeClient::default());
    client.respond("initialize", json!({}));
    client.respond(
        "thread/start",
        json!({"thread":{"id":"thread-1","sessionId":"session-1"}}),
    );
    client.respond("thread/resume", json!({"thread":{"id":"thread-1"}}));
    let runtime = CodexRuntime::with_client(database.clone(), files, client.clone());
    let thread_id = runtime
        .start_conversation_thread(&project.id, &conversation.id, None)
        .unwrap();
    assert_eq!(thread_id, "thread-1");
    runtime
        .resume_conversation_thread(&project.id, &conversation.id)
        .unwrap();
    let calls = client.calls();
    let start = calls
        .iter()
        .find(|(method, _)| method == "thread/start")
        .unwrap();
    assert_eq!(start.1["permissions"], "qizhi-project");
    assert!(start.1.get("sandbox").is_none());
    assert!(start.1["cwd"].as_str().unwrap().ends_with("workspace"));
    assert!(
        start.1["developerInstructions"]
            .as_str()
            .unwrap()
            .contains("materials")
    );
    let stored = database
        .codex()
        .list_conversations(&project.id, false)
        .unwrap();
    assert_eq!(stored[0].codex_thread_id.as_deref(), Some("thread-1"));
    assert_eq!(stored[0].codex_session_id.as_deref(), Some("session-1"));
    let resume = calls
        .iter()
        .find(|(method, _)| method == "thread/resume")
        .unwrap();
    assert_eq!(resume.1["threadId"], "thread-1");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resumes_a_persisted_thread_once_before_using_it_in_a_new_runtime() {
    let (root, database, files) = fixture("persisted-thread");
    let project = database
        .codex()
        .create_project("长期项目", None, "managed", 10)
        .unwrap();
    let conversation = database
        .codex()
        .create_conversation(&project.id, "持续会话", 11)
        .unwrap();
    database
        .codex()
        .attach_thread(&conversation.id, "thread-persisted", "session-root", 12)
        .unwrap();
    let client = Arc::new(FakeClient::default());
    client.respond("initialize", json!({}));
    client.respond(
        "thread/resume",
        json!({"thread":{"id":"thread-persisted","sessionId":"session-root"}}),
    );
    let runtime = CodexRuntime::with_client(database, files, client.clone());

    assert_eq!(
        runtime
            .start_conversation_thread(&project.id, &conversation.id, None)
            .unwrap(),
        "thread-persisted"
    );
    assert_eq!(
        runtime
            .start_conversation_thread(&project.id, &conversation.id, None)
            .unwrap(),
        "thread-persisted"
    );
    assert_eq!(
        client
            .calls()
            .iter()
            .filter(|(method, _)| method == "thread/resume")
            .count(),
        1
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn lists_models_and_their_supported_reasoning_efforts_from_codex() {
    let (root, database, files) = fixture("models");
    let client = Arc::new(FakeClient::default());
    client.respond("initialize", json!({}));
    client.respond(
        "model/list",
        json!({"data":[{
            "id":"gpt-current",
            "displayName":"GPT Current",
            "isDefault":true,
            "defaultReasoningEffort":"medium",
            "supportedReasoningEfforts":[
                {"reasoningEffort":"low"},
                {"reasoningEffort":"medium"},
                {"reasoningEffort":"high"}
            ]
        }]}),
    );
    let runtime = CodexRuntime::with_client(database, files, client);
    let models = runtime.list_models().unwrap();
    assert_eq!(models[0].id, "gpt-current");
    assert_eq!(models[0].display_name, "GPT Current");
    assert_eq!(
        models[0].supported_reasoning_efforts,
        ["low", "medium", "high"]
    );
    let _ = std::fs::remove_dir_all(root);
}
