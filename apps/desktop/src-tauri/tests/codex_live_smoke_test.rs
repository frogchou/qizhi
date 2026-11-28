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
    let models = server
        .request(
            "model/list",
            json!({"limit":100,"includeHidden":false}),
            Duration::from_secs(10),
        )
        .expect("load the current account's model catalog");
    let model = models["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["isDefault"] == true)
        .and_then(|model| model["id"].as_str())
        .expect("the account catalog has a default model");
    #[cfg(windows)]
    {
        let sandbox = server
            .request(
                "windowsSandbox/readiness",
                json!({}),
                Duration::from_secs(10),
            )
            .expect("sandbox readiness");
        assert!(sandbox.get("status").is_some());
    }
    let fixture = tempfile::tempdir().expect("isolated project directory");
    let project_root = fixture.path().canonicalize().unwrap();
    let workspace = project_root.join("workspace");
    let materials = project_root.join("materials");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&materials).unwrap();
    #[cfg(target_os = "macos")]
    std::fs::write(materials.join("input.txt"), "QIZHI_SMOKE_MATERIAL_418").unwrap();
    #[cfg(target_os = "macos")]
    {
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "outside fixture").unwrap();
        let exec = |command: serde_json::Value| {
            server.request("command/exec", json!({
                "command": command, "cwd": project_root, "permissionProfile": "qizhi-project", "timeoutMs": 10000,
            }), Duration::from_secs(15)).expect("run a fixture under the project permission profile")
        };
        let written = exec(json!([
            "/bin/sh",
            "-c",
            "/bin/cat \"$1\" > \"$2\"",
            "qizhi-smoke",
            materials.join("input.txt"),
            workspace.join("output.txt")
        ]));
        assert_eq!(
            written["exitCode"], 0,
            "could not write a generated fixture: {written}"
        );
        assert_ne!(exec(json!(["/bin/cat", outside.path()]))["exitCode"], 0);
        assert_eq!(
            std::fs::read_to_string(workspace.join("output.txt")).unwrap(),
            "QIZHI_SMOKE_MATERIAL_418"
        );
    }
    let thread = server
        .request(
            "thread/start",
            json!({
                "cwd": workspace,
                "model": model,
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
                "model": model,
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
