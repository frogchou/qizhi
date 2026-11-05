use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path},
    sync::Arc,
    thread,
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    codex::runtime::{ActiveTurn, PendingApproval},
    codex::{CodexRuntime, CodexRuntimeError},
    contracts::{
        CodexApprovalInput, CodexArtifactInput, CodexProcessItemInput, CodexTurnEvent,
        CodexTurnResult, StartCodexTurnInput,
    },
};

pub type CodexTurnEventSink = Arc<dyn Fn(CodexTurnEvent) + Send + Sync>;

struct ProjectStartLease {
    runtime: CodexRuntime,
    project_id: String,
}

impl Drop for ProjectStartLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.runtime.state.lock() {
            state.starting_projects.remove(&self.project_id);
        }
    }
}

impl CodexRuntime {
    pub fn start_turn(
        &self,
        input: StartCodexTurnInput,
        sink: CodexTurnEventSink,
    ) -> Result<CodexTurnResult, CodexRuntimeError> {
        if input.prompt.trim().is_empty() {
            return Err(CodexRuntimeError::RequestFailed);
        }
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| CodexRuntimeError::ProcessExited)?;
            if state.active_projects.contains_key(&input.project_id)
                || state.starting_projects.contains(&input.project_id)
                || state.uploading_projects.contains(&input.project_id)
            {
                return Err(CodexRuntimeError::RequestFailed);
            }
            state.starting_projects.insert(input.project_id.clone());
        }
        let _start_lease = ProjectStartLease {
            runtime: self.clone(),
            project_id: input.project_id.clone(),
        };
        if self
            .database
            .codex()
            .project_has_active_turn(&input.project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?
        {
            return Err(CodexRuntimeError::RequestFailed);
        }
        let thread_id = self.start_conversation_thread(
            &input.project_id,
            &input.conversation_id,
            input.model.as_deref(),
        )?;
        let (codex_prompt, handoff_ids) = self.resolve_turn_handoffs(&input)?;
        let local_turn = self
            .database
            .codex()
            .create_turn(&input.conversation_id, input.prompt.trim(), now_ms())
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        for material in self
            .database
            .codex()
            .list_materials(&input.project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?
        {
            if let Some(version_id) = material.current_version_id {
                self.database
                    .codex()
                    .bind_turn_material_version(&local_turn.id, &version_id)
                    .map_err(|_| CodexRuntimeError::RequestFailed)?;
            }
        }
        self.database
            .codex()
            .append_message(
                &local_turn.id,
                "user",
                input.prompt.trim(),
                "completed",
                now_ms(),
            )
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let assistant = self
            .database
            .codex()
            .append_message(&local_turn.id, "assistant", "", "streaming", now_ms())
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let client = self.ensure_started()?;
        let notifications = client.subscribe();
        let layout = self
            .files
            .create_layout(&input.project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let workspace = layout.workspace.to_string_lossy().into_owned();
        let response = match client.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type":"text","text":codex_prompt,"textElements":[]}],
                "cwd": workspace,
                "model": input.model,
                "effort": input.reasoning_effort,
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "permissions": "qizhi-project",
                "runtimeWorkspaceRoots": [layout.root]
            }),
        ) {
            Ok(response) => response,
            Err(error) => {
                self.fail_turn_start(&local_turn.id, &assistant.id);
                return Err(error);
            }
        };
        let codex_turn_id = match response.pointer("/turn/id").and_then(Value::as_str) {
            Some(value) => value.to_owned(),
            None => {
                self.fail_turn_start(&local_turn.id, &assistant.id);
                return Err(CodexRuntimeError::InvalidProtocol);
            }
        };
        if self
            .database
            .codex()
            .attach_turn_id(&local_turn.id, &codex_turn_id)
            .is_err()
        {
            self.interrupt_remote_or_stop(&client, &thread_id, &codex_turn_id);
            self.fail_turn_start(&local_turn.id, &assistant.id);
            return Err(CodexRuntimeError::RequestFailed);
        }
        {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    self.interrupt_remote_or_stop(&client, &thread_id, &codex_turn_id);
                    self.fail_turn_start(&local_turn.id, &assistant.id);
                    return Err(CodexRuntimeError::ProcessExited);
                }
            };
            state.starting_projects.remove(&input.project_id);
            state.active_projects.insert(
                input.project_id.clone(),
                ActiveTurn {
                    thread_id: thread_id.clone(),
                    codex_turn_id: codex_turn_id.clone(),
                },
            );
        }
        if !handoff_ids.is_empty()
            && self
                .database
                .codex()
                .consume_handoffs(
                    &local_turn.id,
                    &input.conversation_id,
                    &handoff_ids,
                    now_ms(),
                )
                .is_err()
        {
            self.interrupt_remote_or_stop(&client, &thread_id, &codex_turn_id);
            if let Ok(mut state) = self.state.lock() {
                state.active_projects.remove(&input.project_id);
            }
            self.fail_turn_start(&local_turn.id, &assistant.id);
            return Err(CodexRuntimeError::RequestFailed);
        }
        sink(CodexTurnEvent::Started {
            project_id: input.project_id.clone(),
            conversation_id: input.conversation_id.clone(),
            local_turn_id: local_turn.id.clone(),
            codex_turn_id: codex_turn_id.clone(),
        });

        let runtime = self.clone();
        let local_turn_id = local_turn.id.clone();
        let worker_input = input.clone();
        let worker_thread_id = thread_id.clone();
        let worker_turn_id = codex_turn_id.clone();
        thread::spawn(move || {
            run_event_loop(
                runtime,
                worker_input,
                local_turn_id,
                assistant.id,
                worker_thread_id,
                worker_turn_id,
                notifications,
                sink,
            );
        });
        Ok(CodexTurnResult {
            local_turn_id: local_turn.id,
            codex_turn_id,
            thread_id,
        })
    }

    fn resolve_turn_handoffs(
        &self,
        input: &StartCodexTurnInput,
    ) -> Result<(String, Vec<String>), CodexRuntimeError> {
        if input.handoff_ids.is_empty() {
            return Ok((input.prompt.trim().to_owned(), Vec::new()));
        }
        let requested = input
            .handoff_ids
            .iter()
            .filter(|id| !id.trim().is_empty())
            .cloned()
            .collect::<HashSet<_>>();
        if requested.len() != input.handoff_ids.len() {
            return Err(CodexRuntimeError::RequestFailed);
        }
        let pending = self
            .database
            .codex()
            .list_pending_handoffs(&input.conversation_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let layout = self
            .files
            .create_layout(&input.project_id)
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let root = layout
            .root
            .canonicalize()
            .map_err(|_| CodexRuntimeError::RequestFailed)?;
        let mut handoff_ids = Vec::with_capacity(requested.len());
        let mut paths = Vec::new();
        for handoff in pending {
            if !requested.contains(&handoff.handoff.id) {
                continue;
            }
            if handoff.handoff.project_id != input.project_id {
                return Err(CodexRuntimeError::RequestFailed);
            }
            let mut ready_items = 0usize;
            for item in handoff.items.iter().filter(|item| item.state == "ready") {
                let version = self
                    .database
                    .codex()
                    .get_material_version(&item.material_version_id)
                    .map_err(|_| CodexRuntimeError::RequestFailed)?
                    .filter(|version| version.material_id == item.material_id)
                    .ok_or(CodexRuntimeError::RequestFailed)?;
                let relative = version
                    .derived_snapshot_path
                    .as_deref()
                    .unwrap_or(&version.original_snapshot_path);
                let relative_path = Path::new(relative);
                if relative_path.is_absolute()
                    || relative_path.components().any(|component| {
                        matches!(
                            component,
                            Component::ParentDir | Component::RootDir | Component::Prefix(_)
                        )
                    })
                {
                    return Err(CodexRuntimeError::RequestFailed);
                }
                let absolute = root.join(relative_path);
                let canonical = absolute
                    .canonicalize()
                    .map_err(|_| CodexRuntimeError::RequestFailed)?;
                let safe_relative = canonical
                    .strip_prefix(&root)
                    .map_err(|_| CodexRuntimeError::RequestFailed)?
                    .to_string_lossy()
                    .replace('\\', "/");
                paths.push(format!("../{safe_relative}"));
                ready_items += 1;
            }
            if ready_items == 0 {
                return Err(CodexRuntimeError::RequestFailed);
            }
            handoff_ids.push(handoff.handoff.id);
        }
        if handoff_ids.len() != requested.len() {
            return Err(CodexRuntimeError::RequestFailed);
        }
        paths.sort();
        paths.dedup();
        let mut guidance =
            String::from("<qizhi_handoff>\n本轮重点资料（均为当前项目内的只读快照）：\n");
        for path in paths {
            let line = format!("- {path}\n");
            if guidance.len() + line.len() > 31_000 {
                guidance.push_str("- （其余资料已省略，请查看项目资料目录）\n");
                break;
            }
            guidance.push_str(&line);
        }
        guidance.push_str("</qizhi_handoff>\n\n用户任务：\n");
        guidance.push_str(input.prompt.trim());
        Ok((guidance, handoff_ids))
    }

    fn fail_turn_start(&self, local_turn_id: &str, assistant_message_id: &str) {
        let summary = "Codex 未能启动本次任务。";
        let _ = self
            .database
            .codex()
            .update_message(assistant_message_id, summary, "failed");
        let _ =
            self.database
                .codex()
                .complete_turn(local_turn_id, "failed", Some(summary), now_ms());
    }

    fn interrupt_remote_or_stop(
        &self,
        client: &Arc<dyn crate::codex::AppServerClient>,
        thread_id: &str,
        codex_turn_id: &str,
    ) {
        if client
            .request(
                "turn/interrupt",
                json!({"threadId":thread_id,"turnId":codex_turn_id}),
            )
            .is_err()
        {
            client.shutdown();
            self.force_stop_server();
        }
    }

    pub fn interrupt_turn(&self, project_id: &str) -> Result<(), CodexRuntimeError> {
        let active = self
            .state
            .lock()
            .map_err(|_| CodexRuntimeError::ProcessExited)?
            .active_projects
            .get(project_id)
            .cloned()
            .ok_or(CodexRuntimeError::RequestFailed)?;
        self.ensure_started()?.request(
            "turn/interrupt",
            json!({"threadId":active.thread_id,"turnId":active.codex_turn_id}),
        )?;
        Ok(())
    }

    pub fn resolve_approval(
        &self,
        request_id: String,
        decision: &str,
    ) -> Result<(), CodexRuntimeError> {
        if !matches!(
            decision,
            "accept" | "acceptForSession" | "decline" | "cancel"
        ) {
            return Err(CodexRuntimeError::RequestFailed);
        }
        let approval = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| CodexRuntimeError::ProcessExited)?;
            if state.resolved_approvals.contains(&request_id) {
                return Err(CodexRuntimeError::RequestFailed);
            }
            let approval = state
                .pending_approvals
                .remove(&request_id)
                .ok_or(CodexRuntimeError::RequestFailed)?;
            state.resolved_approvals.insert(request_id.clone());
            approval
        };
        self.ensure_started()?
            .respond(approval.request_id.clone(), json!({"decision":decision}))?;
        self.database
            .codex()
            .record_approval(&CodexApprovalInput {
                project_id: approval.project_id,
                conversation_id: approval.conversation_id,
                turn_id: approval.local_turn_id,
                item_id: approval.item_id,
                action_type: approval.action_type,
                target_summary: approval.target_summary,
                decision: decision.to_owned(),
                created_at_utc_ms: now_ms(),
            })
            .map_err(|_| CodexRuntimeError::RequestFailed)
    }
}

#[allow(clippy::too_many_arguments)]
fn run_event_loop(
    runtime: CodexRuntime,
    input: StartCodexTurnInput,
    local_turn_id: String,
    assistant_message_id: String,
    thread_id: String,
    codex_turn_id: String,
    notifications: std::sync::mpsc::Receiver<crate::codex::AppServerNotification>,
    sink: CodexTurnEventSink,
) {
    let mut answer = String::new();
    let mut reasoning_summaries = HashMap::<String, String>::new();
    let mut terminal: Option<(String, Option<String>)> = None;
    while terminal.is_none() {
        let notification = match notifications.recv_timeout(Duration::from_secs(30 * 60)) {
            Ok(value) => value,
            Err(_) => {
                terminal = Some(("failed".to_owned(), Some("Codex 连接已中断。".to_owned())));
                continue;
            }
        };
        let event_thread = notification.params.get("threadId").and_then(Value::as_str);
        let event_turn = notification
            .params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| {
                notification
                    .params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
            });
        if event_thread != Some(thread_id.as_str()) || event_turn != Some(codex_turn_id.as_str()) {
            continue;
        }
        match notification.method.as_str() {
            "item/agentMessage/delta" => {
                if let Some(delta) = notification.params.get("delta").and_then(Value::as_str) {
                    answer.push_str(delta);
                    let _ = runtime.database.codex().update_message(
                        &assistant_message_id,
                        &answer,
                        "streaming",
                    );
                    sink(CodexTurnEvent::MessageDelta {
                        local_turn_id: local_turn_id.clone(),
                        delta: delta.to_owned(),
                    });
                }
            }
            "item/reasoning/summaryTextDelta" => {
                let item_id = notification
                    .params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("reasoning");
                let summary = notification
                    .params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let accumulated = reasoning_summaries.entry(item_id.to_owned()).or_default();
                accumulated.push_str(summary);
                persist_process(
                    &runtime,
                    &local_turn_id,
                    item_id,
                    "reasoning",
                    "思考与执行",
                    accumulated,
                    "running",
                    &sink,
                );
            }
            "item/started" | "item/completed" => {
                let item = notification.params.get("item").unwrap_or(&Value::Null);
                let item_id = item.get("id").and_then(Value::as_str).unwrap_or("item");
                let kind = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("activity");
                if notification.method.ends_with("completed")
                    && kind == "agentMessage"
                    && let Some(final_text) = item.get("text").and_then(Value::as_str)
                {
                    answer = final_text.to_owned();
                }
                if kind != "reasoning" {
                    let title = friendly_item_title(kind);
                    let summary = safe_item_summary(item);
                    let status = if notification.method.ends_with("completed") {
                        "completed"
                    } else {
                        "running"
                    };
                    persist_process(
                        &runtime,
                        &local_turn_id,
                        item_id,
                        kind,
                        title,
                        &summary,
                        status,
                        &sink,
                    );
                }
            }
            "turn/completed" => {
                let raw_status = notification
                    .params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                let status = match raw_status {
                    "completed" => "completed",
                    "interrupted" => "interrupted",
                    _ => "failed",
                };
                let error = notification
                    .params
                    .pointer("/turn/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                terminal = Some((status.to_owned(), error));
            }
            method if notification.request_id.is_some() && method.contains("requestApproval") => {
                let request_value = notification.request_id.unwrap_or(Value::Null);
                let request_id = match &request_value {
                    Value::String(value) => value.clone(),
                    value => value.to_string(),
                };
                let item_id = notification
                    .params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("approval")
                    .to_owned();
                let target_summary = approval_summary(&notification.params);
                let action_type = if method.contains("fileChange") {
                    "file_change"
                } else if method.contains("permissions") {
                    "permissions"
                } else {
                    "command"
                }
                .to_owned();
                if let Ok(mut state) = runtime.state.lock() {
                    state.pending_approvals.insert(
                        request_id.clone(),
                        PendingApproval {
                            request_id: request_value,
                            project_id: input.project_id.clone(),
                            conversation_id: input.conversation_id.clone(),
                            local_turn_id: local_turn_id.clone(),
                            item_id: item_id.clone(),
                            action_type: action_type.clone(),
                            target_summary: target_summary.clone(),
                        },
                    );
                }
                sink(CodexTurnEvent::ApprovalRequested {
                    local_turn_id: local_turn_id.clone(),
                    request_id,
                    item_id,
                    action_type,
                    target_summary,
                });
            }
            _ => {}
        }
    }
    let (status, error) =
        terminal.unwrap_or(("failed".to_owned(), Some("Codex 连接已中断。".to_owned())));
    let _ = runtime
        .database
        .codex()
        .update_message(&assistant_message_id, &answer, &status);
    let _ =
        runtime
            .database
            .codex()
            .complete_turn(&local_turn_id, &status, error.as_deref(), now_ms());
    let artifacts = record_artifacts(
        &runtime,
        &input.project_id,
        &input.conversation_id,
        &local_turn_id,
    );
    if let Ok(mut state) = runtime.state.lock() {
        state.active_projects.remove(&input.project_id);
        state
            .pending_approvals
            .retain(|_, value| value.local_turn_id != local_turn_id);
    }
    sink(CodexTurnEvent::Completed {
        local_turn_id,
        status,
        error,
        artifacts,
    });
}

#[allow(clippy::too_many_arguments)]
fn persist_process(
    runtime: &CodexRuntime,
    turn_id: &str,
    item_id: &str,
    kind: &str,
    title: &str,
    summary: &str,
    status: &str,
    sink: &CodexTurnEventSink,
) {
    let summary = truncate(summary, 1200);
    let _ = runtime
        .database
        .codex()
        .upsert_process_item(&CodexProcessItemInput {
            turn_id: turn_id.to_owned(),
            codex_item_id: item_id.to_owned(),
            kind: kind.to_owned(),
            title: title.to_owned(),
            safe_summary: summary.clone(),
            status: status.to_owned(),
        });
    sink(CodexTurnEvent::ProcessItem {
        local_turn_id: turn_id.to_owned(),
        item_id: item_id.to_owned(),
        kind: kind.to_owned(),
        title: title.to_owned(),
        summary,
        status: status.to_owned(),
    });
}

fn record_artifacts(
    runtime: &CodexRuntime,
    project_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Vec<crate::contracts::CodexArtifact> {
    if let Ok(items) = runtime.files.scan_artifacts(project_id) {
        for item in items {
            let relative_path = item.relative_path.to_string_lossy().replace('\\', "/");
            let _ = runtime
                .database
                .codex()
                .record_artifact(&CodexArtifactInput {
                    project_id: project_id.to_owned(),
                    relative_path,
                    content_hash: item.content_hash,
                    size_bytes: item.size_bytes as i64,
                    mime_type: "application/octet-stream".to_owned(),
                    created_by_conversation_id: Some(conversation_id.to_owned()),
                    created_by_turn_id: Some(turn_id.to_owned()),
                    detected_at_utc_ms: now_ms(),
                });
        }
    }
    runtime
        .database
        .codex()
        .list_artifacts(project_id)
        .unwrap_or_default()
}

fn friendly_item_title(kind: &str) -> &str {
    match kind {
        "commandExecution" => "运行命令",
        "fileChange" => "修改文件",
        "mcpToolCall" => "调用工具",
        "webSearch" => "搜索网络",
        _ => "执行任务",
    }
}

fn safe_item_summary(item: &Value) -> String {
    item.get("command")
        .and_then(Value::as_str)
        .or_else(|| item.get("path").and_then(Value::as_str))
        .or_else(|| item.get("server").and_then(Value::as_str))
        .or_else(|| item.get("query").and_then(Value::as_str))
        .map(|value| truncate(value, 1200))
        .unwrap_or_default()
}

fn approval_summary(params: &Value) -> String {
    params
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| params.get("reason").and_then(Value::as_str))
        .or_else(|| params.get("cwd").and_then(Value::as_str))
        .map(|value| truncate(value, 800))
        .unwrap_or_else(|| "Codex 请求继续执行此操作。".to_owned())
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}
