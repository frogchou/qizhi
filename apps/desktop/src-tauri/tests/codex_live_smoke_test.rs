use std::time::{Duration, Instant};

use qizhi_desktop_lib::codex::{AppServerProcess, CodexInstallationProbe, CodexInstallationState};
use serde_json::json;

#[test]
#[ignore = "requires a locally installed Codex"]
fn connects_to_the_local_codex_account_without_a_second_login() {
    let installation = CodexInstallationProbe::detect();
    assert_eq!(installation.state, CodexInstallationState::Ready);
    let server = AppServerProcess::spawn().expect("start app-server");
    server.request("initialize", json!({"clientInfo":{"name":"qizhi-smoke","version":"0.1.0"},"capabilities":{"experimentalApi":true}}), Duration::from_secs(10)).expect("initialize");
    server
        .notify("initialized", json!({}))
        .expect("initialized notification");
    let account = server
        .request(
            "account/read",
            json!({"refreshToken":false}),
            Duration::from_secs(10),
        )
        .expect("account/read");
    assert!(account.get("requiresOpenaiAuth").is_some());
    let sandbox = server
        .request(
            "windowsSandbox/readiness",
            json!({}),
            Duration::from_secs(10),
        )
        .expect("sandbox readiness");
    assert!(sandbox.get("status").is_some());
    let project_root = std::env::temp_dir().join("qizhi-codex-live-smoke-project");
    let workspace = project_root.join("workspace");
    let materials = project_root.join("materials");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&materials).unwrap();
    let thread = server
        .request(
            "thread/start",
            json!({
                "cwd": workspace,
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "permissions": "qizhi-project",
                "runtimeWorkspaceRoots": [project_root],
                "ephemeral": true,
                "developerInstructions": "栖知连接测试，不执行任务。",
            }),
            Duration::from_secs(10),
        )
        .expect("thread/start");
    assert!(
        thread
            .pointer("/thread/id")
            .and_then(serde_json::Value::as_str)
            .is_some()
    );
    let thread_id = thread
        .pointer("/thread/id")
        .and_then(serde_json::Value::as_str)
        .unwrap();
    let profiles = server
        .request(
            "permissionProfile/list",
            json!({"cwd": workspace, "limit": 20}),
            Duration::from_secs(10),
        )
        .expect("permissionProfile/list");
    assert!(profiles["data"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["id"] == "qizhi-project" && item["allowed"] == true)
    }));
    let notifications = server.subscribe();
    let turn = server
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type":"text","text":"只回复：栖知连接正常。"}],
                "cwd": workspace,
                "approvalPolicy": "on-request",
                "permissions": "qizhi-project",
                "runtimeWorkspaceRoots": [project_root]
            }),
            Duration::from_secs(20),
        )
        .expect("turn/start");
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(serde_json::Value::as_str)
        .expect("turn id");
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut answer = String::new();
    let mut completed = false;
    let mut terminal = None;
    while Instant::now() < deadline {
        let Ok(event) = notifications.recv_timeout(Duration::from_secs(5)) else {
            continue;
        };
        if event
            .params
            .get("turnId")
            .and_then(serde_json::Value::as_str)
            != Some(turn_id)
            && event
                .params
                .pointer("/turn/id")
                .and_then(serde_json::Value::as_str)
                != Some(turn_id)
        {
            continue;
        }
        if event.method == "item/agentMessage/delta" {
            if let Some(delta) = event
                .params
                .get("delta")
                .and_then(serde_json::Value::as_str)
            {
                answer.push_str(delta);
            }
        }
        if event.method == "turn/completed" {
            terminal = Some(event.params.clone());
            completed = event
                .params
                .pointer("/turn/status")
                .and_then(serde_json::Value::as_str)
                == Some("completed");
            break;
        }
    }
    assert!(completed, "live turn did not complete: {terminal:#?}");
    assert!(answer.contains("栖知连接正常"));
    server.shutdown();
}
