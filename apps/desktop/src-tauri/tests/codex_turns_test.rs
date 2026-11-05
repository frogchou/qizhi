use std::{
    collections::HashMap,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use qizhi_desktop_lib::{
    codex::{
        AppServerClient, AppServerNotification, CodexProjectFiles, CodexRuntime, CodexRuntimeError,
    },
    contracts::{
        CodexHandoffItemInput, CodexMaterialVersionInput, CodexTurnEvent, StartCodexTurnInput,
    },
    database::Database,
};
use serde_json::{Value, json};

#[derive(Default)]
struct StreamingClient {
    responses: Mutex<HashMap<String, Vec<Value>>>,
    subscribers: Mutex<Vec<mpsc::Sender<AppServerNotification>>>,
    calls: Mutex<Vec<(String, Value)>>,
    turn_start_entered: Mutex<Option<mpsc::Sender<()>>>,
    turn_start_release: Mutex<Option<mpsc::Receiver<()>>>,
}
impl StreamingClient {
    fn respond_with(&self, method: &str, value: Value) {
        self.responses
            .lock()
            .unwrap()
            .entry(method.to_owned())
            .or_default()
            .push(value);
    }
    fn emit(&self, method: &str, params: Value) {
        self.subscribers.lock().unwrap().retain(|sender| {
            sender
                .send(AppServerNotification {
                    method: method.to_owned(),
                    params: params.clone(),
                    request_id: None,
                })
                .is_ok()
        });
    }
}
impl AppServerClient for StreamingClient {
    fn request(&self, method: &str, params: Value) -> Result<Value, CodexRuntimeError> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        if method == "turn/start" {
            if let Some(sender) = self.turn_start_entered.lock().unwrap().take() {
                let _ = sender.send(());
            }
            if let Some(receiver) = self.turn_start_release.lock().unwrap().take() {
                let _ = receiver.recv();
            }
        }
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
    fn notify(&self, _method: &str, _params: Value) -> Result<(), CodexRuntimeError> {
        Ok(())
    }
    fn shutdown(&self) {}
    fn subscribe(&self) -> mpsc::Receiver<AppServerNotification> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers.lock().unwrap().push(sender);
        receiver
    }
}

#[test]
fn rejects_a_second_start_while_the_first_start_is_still_in_flight() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("qizhi-codex-turn-race-{nonce}"));
    std::fs::create_dir_all(&root).unwrap();
    let database = Database::open(&root.join("qizhi.db")).unwrap();
    let files = CodexProjectFiles::new(root.join("projects"));
    let project = database
        .codex()
        .create_project("项目", None, "managed", 1)
        .unwrap();
    let conversation = database
        .codex()
        .create_conversation(&project.id, "会话", 2)
        .unwrap();
    let client = Arc::new(StreamingClient::default());
    client.respond_with("initialize", json!({}));
    client.respond_with("thread/start", json!({"thread":{"id":"thread-race"}}));
    client.respond_with(
        "turn/start",
        json!({"turn":{"id":"turn-race","status":"inProgress","items":[]}}),
    );
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *client.turn_start_entered.lock().unwrap() = Some(entered_tx);
    *client.turn_start_release.lock().unwrap() = Some(release_rx);
    let runtime = CodexRuntime::with_client(database, files, client.clone());
    let first_runtime = runtime.clone();
    let first_project = project.id.clone();
    let first_conversation = conversation.id.clone();
    let first = thread::spawn(move || {
        first_runtime.start_turn(
            StartCodexTurnInput {
                project_id: first_project,
                conversation_id: first_conversation,
                prompt: "第一个任务".to_owned(),
                model: None,
                reasoning_effort: None,
                handoff_ids: Vec::new(),
            },
            Arc::new(|_| {}),
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

    assert!(
        runtime
            .start_turn(
                StartCodexTurnInput {
                    project_id: project.id.clone(),
                    conversation_id: conversation.id.clone(),
                    prompt: "第二个任务".to_owned(),
                    model: None,
                    reasoning_effort: None,
                    handoff_ids: Vec::new(),
                },
                Arc::new(|_| {}),
            )
            .is_err()
    );
    release_tx.send(()).unwrap();
    first.join().unwrap().unwrap();
    client.emit(
        "turn/completed",
        json!({"threadId":"thread-race","turn":{"id":"turn-race","status":"completed","items":[]}}),
    );
    for _ in 0..40 {
        if !runtime.project_has_active_turn(&project.id) {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(!runtime.project_has_active_turn(&project.id));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn streams_only_safe_reasoning_summary_and_persists_the_completed_answer_and_artifact() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("qizhi-codex-turn-{nonce}"));
    std::fs::create_dir_all(&root).unwrap();
    let database = Database::open(&root.join("qizhi.db")).unwrap();
    let files = CodexProjectFiles::new(root.join("projects"));
    let project = database
        .codex()
        .create_project("项目", None, "managed", 1)
        .unwrap();
    let conversation = database
        .codex()
        .create_conversation(&project.id, "会话", 2)
        .unwrap();
    let layout = files.create_layout(&project.id).unwrap();
    std::fs::write(layout.workspace.join("result.md"), "artifact").unwrap();
    let material = database
        .codex()
        .create_material(&project.id, "local", "brief.md", None, 3)
        .unwrap();
    let material_version = database
        .codex()
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material.id.clone(),
            original_snapshot_path: "materials/local/brief.md".to_owned(),
            derived_snapshot_path: Some("materials/local/brief.md.derived.md".to_owned()),
            content_hash: "material-hash".to_owned(),
            size_bytes: 10,
            mime_type: "text/markdown".to_owned(),
            extractor_version: Some("test".to_owned()),
            created_at_utc_ms: 4,
        })
        .unwrap();
    std::fs::create_dir_all(layout.root.join("materials/local")).unwrap();
    std::fs::write(
        layout.root.join("materials/local/brief.md"),
        "original material",
    )
    .unwrap();
    std::fs::write(
        layout.root.join("materials/local/brief.md.derived.md"),
        "derived material",
    )
    .unwrap();
    let handoff = database
        .codex()
        .create_handoff(
            "request-turn-material",
            "today",
            &project.id,
            &conversation.id,
            5,
        )
        .unwrap();
    database
        .codex()
        .mark_handoff_ready(
            &handoff.id,
            &[CodexHandoffItemInput {
                material_id: material.id.clone(),
                material_version_id: material_version.id.clone(),
                display_name: "brief.md".to_owned(),
                source_metadata_json: "{}".to_owned(),
                display_order: 0,
            }],
        )
        .unwrap();
    let client = Arc::new(StreamingClient::default());
    client.respond_with("initialize", json!({}));
    client.respond_with("thread/start", json!({"thread":{"id":"thread-a"}}));
    client.respond_with(
        "turn/start",
        json!({"turn":{"id":"turn-a","status":"inProgress","items":[]}}),
    );
    let runtime = CodexRuntime::with_client(database.clone(), files, client.clone());
    let (event_sender, event_receiver) = mpsc::channel();
    let result = runtime
        .start_turn(
            StartCodexTurnInput {
                project_id: project.id.clone(),
                conversation_id: conversation.id.clone(),
                prompt: "生成结果".to_owned(),
                model: None,
                reasoning_effort: None,
                handoff_ids: vec![handoff.id.clone()],
            },
            Arc::new(move |event| {
                let _ = event_sender.send(event);
            }),
        )
        .unwrap();
    let calls = client.calls.lock().unwrap();
    let turn_start = calls
        .iter()
        .find(|(method, _)| method == "turn/start")
        .expect("turn/start request");
    assert_eq!(turn_start.1["permissions"], "qizhi-project");
    assert!(
        turn_start.1["runtimeWorkspaceRoots"][0]
            .as_str()
            .unwrap()
            .ends_with(&project.id)
    );
    assert!(turn_start.1.get("sandboxPolicy").is_none());
    let sent_prompt = turn_start.1["input"][0]["text"].as_str().unwrap();
    assert!(sent_prompt.contains("../materials/local/brief.md.derived.md"));
    assert!(sent_prompt.contains("生成结果"));
    drop(calls);
    client.emit("item/reasoning/textDelta", json!({"threadId":"thread-a","turnId":"turn-a","itemId":"reasoning","delta":"private chain of thought"}));
    client.emit("item/reasoning/summaryTextDelta", json!({"threadId":"thread-a","turnId":"turn-a","itemId":"reasoning","summaryIndex":0,"delta":"正在整理资料"}));
    client.emit(
        "item/agentMessage/delta",
        json!({"threadId":"thread-a","turnId":"turn-a","itemId":"answer","delta":"完成"}),
    );
    client.emit(
        "turn/completed",
        json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed","items":[]}}),
    );
    let mut completed = false;
    for _ in 0..8 {
        if matches!(
            event_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            CodexTurnEvent::Completed { .. }
        ) {
            completed = true;
            break;
        }
    }
    assert!(completed);
    let history = database
        .codex()
        .read_conversation(&conversation.id)
        .unwrap();
    let turn = history
        .turns
        .iter()
        .find(|turn| turn.turn.id == result.local_turn_id)
        .unwrap();
    assert_eq!(
        turn.messages
            .iter()
            .find(|message| message.role == "assistant")
            .unwrap()
            .markdown,
        "完成"
    );
    assert!(
        turn.process_items
            .iter()
            .any(|item| item.safe_summary.contains("正在整理资料"))
    );
    assert!(!format!("{turn:?}").contains("private chain of thought"));
    assert_eq!(
        database.codex().list_artifacts(&project.id).unwrap().len(),
        1
    );
    assert_eq!(
        database
            .codex()
            .list_turn_material_versions(&result.local_turn_id)
            .unwrap()[0]
            .id,
        material_version.id
    );
    assert_eq!(
        database
            .codex()
            .list_turn_handoffs(&result.local_turn_id)
            .unwrap(),
        vec![handoff.id.clone()]
    );
    assert!(
        database
            .codex()
            .list_pending_handoffs(&conversation.id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(turn.turn.user_text, "生成结果");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn marks_the_local_turn_failed_when_codex_rejects_turn_start() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("qizhi-codex-turn-start-failure-{nonce}"));
    std::fs::create_dir_all(&root).unwrap();
    let database = Database::open(&root.join("qizhi.db")).unwrap();
    let files = CodexProjectFiles::new(root.join("projects"));
    let project = database
        .codex()
        .create_project("项目", None, "managed", 1)
        .unwrap();
    let conversation = database
        .codex()
        .create_conversation(&project.id, "会话", 2)
        .unwrap();
    let layout = files.create_layout(&project.id).unwrap();
    let material = database
        .codex()
        .create_material(&project.id, "local", "brief.md", None, 3)
        .unwrap();
    std::fs::create_dir_all(layout.root.join("materials/local")).unwrap();
    std::fs::write(layout.root.join("materials/local/brief.md"), "brief").unwrap();
    let version = database
        .codex()
        .record_material_version(&CodexMaterialVersionInput {
            material_id: material.id.clone(),
            original_snapshot_path: "materials/local/brief.md".to_owned(),
            derived_snapshot_path: None,
            content_hash: "hash".to_owned(),
            size_bytes: 5,
            mime_type: "text/markdown".to_owned(),
            extractor_version: None,
            created_at_utc_ms: 4,
        })
        .unwrap();
    let handoff = database
        .codex()
        .create_handoff(
            "request-failed-turn",
            "today",
            &project.id,
            &conversation.id,
            5,
        )
        .unwrap();
    database
        .codex()
        .mark_handoff_ready(
            &handoff.id,
            &[CodexHandoffItemInput {
                material_id: material.id,
                material_version_id: version.id,
                display_name: "brief.md".to_owned(),
                source_metadata_json: "{}".to_owned(),
                display_order: 0,
            }],
        )
        .unwrap();
    let client = Arc::new(StreamingClient::default());
    client.respond_with("initialize", json!({}));
    client.respond_with(
        "thread/start",
        json!({"thread":{"id":"thread-a","sessionId":"session-a"}}),
    );
    let runtime = CodexRuntime::with_client(database.clone(), files, client);

    assert!(
        runtime
            .start_turn(
                StartCodexTurnInput {
                    project_id: project.id,
                    conversation_id: conversation.id.clone(),
                    prompt: "生成结果".to_owned(),
                    model: None,
                    reasoning_effort: None,
                    handoff_ids: vec![handoff.id.clone()],
                },
                Arc::new(|_| {}),
            )
            .is_err()
    );

    let history = database
        .codex()
        .read_conversation(&conversation.id)
        .unwrap();
    assert_eq!(history.conversation.status, "unavailable");
    assert_eq!(history.turns[0].turn.status, "failed");
    let assistant = history.turns[0]
        .messages
        .iter()
        .find(|message| message.role == "assistant")
        .unwrap();
    assert_eq!(assistant.status, "failed");
    assert_eq!(
        database
            .codex()
            .list_pending_handoffs(&conversation.id)
            .unwrap()[0]
            .handoff
            .id,
        handoff.id
    );
    let _ = std::fs::remove_dir_all(root);
}
