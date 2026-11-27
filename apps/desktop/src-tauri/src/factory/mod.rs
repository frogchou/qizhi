mod connection;
mod download;
pub(crate) use download::suggested_name;
mod route;
pub(crate) mod upload;

use crate::{config::secret_store::WindowsCredentialStore, database::Database};
use connection::{Auth, ConnectionInput, ConnectionStore, Settings};
use futures_util::future::{AbortHandle, Abortable};
use reqwest::{Client, Method, StatusCode, header};
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::State;
use uuid::Uuid;

const WIRE_ERROR: &str = "工厂服务返回了无效数据，请检查控制面地址和版本。";
const MAX_JSON: usize = 16 * 1024 * 1024;

pub struct FactoryBridge {
    connection: ConnectionStore<WindowsCredentialStore>,
    client: Client,
    reads: Mutex<HashMap<Uuid, AbortHandle>>,
}

impl FactoryBridge {
    pub fn new(database: Database) -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(6))
            .build()?;
        Ok(Self {
            connection: ConnectionStore::new(database, WindowsCredentialStore),
            client,
            reads: Mutex::new(HashMap::new()),
        })
    }
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "工厂请求超时，请刷新查看服务器状态。".into()
    } else {
        "无法连接工厂，请检查网络、服务地址和证书。".into()
    }
}

fn public_status(status: StatusCode) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    let message = match status.as_u16() {
        300..=399 => "工厂地址返回了重定向，请在设置中输入最终地址。",
        400 | 413 | 422 => "工厂未接受请求，请检查填写的参数。",
        401 | 403 => "工厂拒绝访问，请检查管理员令牌和权限。",
        404 => "工厂未找到该资源或接口，请刷新并检查控制面版本。",
        409 => "服务器状态已变化或此操作与当前状态冲突，请刷新后重试。",
        429 => "工厂请求过于频繁，请稍后重试。",
        502..=504 => "工厂后台服务暂不可用，请稍后重试。",
        _ => "工厂未能完成此请求，请检查控制面状态。",
    };
    Err(format!("{message}（HTTP {}）", status.as_u16()))
}

// Only map known operator-facing conditions; a control plane or proxy can return
// stack traces, internal paths or credentials in any other field.
fn operation_failure(path: &str, status: StatusCode, payload: &Value) -> Option<String> {
    if !matches!(status.as_u16(), 400 | 403 | 409 | 422 | 503) {
        return None;
    }
    let code = payload.get("code").and_then(Value::as_str).unwrap_or("");
    let legacy = payload.get("message").and_then(Value::as_str).unwrap_or("");
    if path.starts_with("/v1/factory/assemblies")
        || path.starts_with("/v1/factory/assembly-resources")
        || path == "/v1/factory/releases"
        || path.ends_with("/upgrade")
    {
        if status == StatusCode::CONFLICT && code == "assembly_version_too_low" {
            let version = payload["nextVersion"].as_str()?;
            if version.split('.').count() == 3
                && version
                    .split('.')
                    .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
            {
                return Some(format!(
                    "目标版本必须高于所有历史和待登记版本，可使用 {version}。（HTTP 409）"
                ));
            }
        }
        let reasons: Vec<&str> = serde_json::from_str(include_str!(
            "../../../src/features/factory/assembly-errors.json"
        ))
        .ok()?;
        return reasons
            .contains(&legacy)
            .then(|| format!("{legacy}（HTTP {}）", status.as_u16()));
    }
    let message = if path.starts_with("/v1/factory/agents/") && path.ends_with("/delete") {
        if path.contains("/versions/")
            && status == StatusCode::CONFLICT
            && code == "agent_version_in_use"
        {
            let ids: Vec<_> = payload["taskIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|s| route::valid_id(s))
                .take(20)
                .collect();
            let detail = if ids.is_empty() {
                "请查看此版本的在办工单。".to_owned()
            } else {
                format!("关联工单 {}", ids.join("、"))
            };
            return Some(format!("此版本仍被未结束的工单使用。{detail}（HTTP 409）"));
        }
        match (status.as_u16(), code) {
            (409, "agent_version_busy") if path.contains("/versions/") => {
                "此版本正在自检或下线，请完成后再删除。"
            }
            (503, "agent_version_delete_incomplete") if path.contains("/versions/") => {
                "节点尚未完成版本撤销，请刷新后重试删除此版本。"
            }
            (409, "agent_in_use") => {
                "仍有未结束的工单使用此智能体。请等待工单结束，或先停止相关工单，再刷新重试。"
            }
            (403 | 409, "agent_protected") => "此智能体受中台保护，无法删除。",
            (409, "agent_busy") => "智能体正在变更，请等待完成后刷新再试。",
            (503, "agent_delete_incomplete") => {
                "智能体删除尚未完成。请刷新查看状态，待服务恢复后重试删除。"
            }
            _ => return None,
        }
    } else if status == StatusCode::CONFLICT
        && path.starts_with("/v1/tasks/")
        && path.ends_with("/stop")
    {
        match (code, legacy) {
            ("task_already_finished", _) | (_, "任务已经结束。") => {
                "工单已经结束，请刷新查看最终状态。"
            }
            ("task_stop_pending", _)
            | (_, "节点管理服务未确认全部实例已停止，可重试停止任务。") => {
                "部分执行实例尚未确认停止。请刷新工单状态，必要时重试停止。"
            }
            _ => return None,
        }
    } else {
        return None;
    };
    Some(format!("{message}（HTTP {}）", status.as_u16()))
}

async fn bounded_json(response: &mut reqwest::Response, limit: usize) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(WIRE_ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(WIRE_ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| WIRE_ERROR.into())
}

async fn json_request(
    client: &Client,
    auth: Auth,
    method: Method,
    path: &str,
    body: Option<Value>,
    key: Option<String>,
) -> Result<Value, String> {
    let timeout = if method == Method::POST {
        120
    } else if path.starts_with("/v1/factory/changes") {
        40
    } else {
        20
    };
    let mut request = client
        .request(method.clone(), format!("{}{path}", auth.endpoint))
        .bearer_auth(auth.token)
        .header(header::ACCEPT, "application/json")
        .timeout(Duration::from_secs(timeout));
    if method == Method::POST {
        let body = body.unwrap_or_else(|| serde_json::json!({}));
        if !body.is_object() {
            return Err("工厂操作需要有效的参数。".to_owned());
        }
        let payload = serde_json::to_vec(&body).map_err(|_| WIRE_ERROR)?;
        if payload.len() > 2 * 1024 * 1024 {
            return Err("工厂请求过大。".to_owned());
        }
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(payload);
    } else if body.is_some() {
        return Err("工厂查询参数无效。".to_owned());
    }
    if (path.ends_with("/respond") || (path.ends_with("/review") && key.is_some()))
        && method == Method::POST
    {
        let key = key.unwrap_or_else(|| Uuid::new_v4().to_string());
        if key.is_empty()
            || key.len() > 160
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err("工厂操作标识无效。".to_owned());
        }
        request = request.header("Idempotency-Key", key);
    } else if key.is_some() {
        return Err("工厂操作标识无效。".to_owned());
    }
    let mut response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    if let Err(fallback) = public_status(status) {
        if (method == Method::POST || path.ends_with("/upgrade"))
            && matches!(status.as_u16(), 400 | 403 | 409 | 422 | 503)
            && (path.ends_with("/delete")
                || path.ends_with("/stop")
                || path.starts_with("/v1/factory/assemblies")
                || path.starts_with("/v1/factory/assembly-resources")
                || path == "/v1/factory/releases"
                || path.ends_with("/upgrade"))
        {
            let payload = bounded_json(&mut response, 16 * 1024)
                .await
                .unwrap_or(Value::Null);
            return Err(operation_failure(path, status, &payload).unwrap_or(fallback));
        }
        return Err(fallback);
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    bounded_json(&mut response, MAX_JSON).await
}

#[tauri::command]
pub fn factory_get_settings(state: State<'_, FactoryBridge>) -> Result<Settings, String> {
    state.connection.settings()
}

#[tauri::command]
pub fn factory_save_settings(
    state: State<'_, FactoryBridge>,
    input: ConnectionInput,
) -> Result<Settings, String> {
    state.connection.save(input)
}

#[tauri::command]
pub async fn factory_test_connection(
    state: State<'_, FactoryBridge>,
    input: ConnectionInput,
) -> Result<(), String> {
    let auth = state.connection.for_test(input)?;
    let overview = json_request(
        &state.client,
        auth,
        Method::GET,
        "/v1/factory/overview",
        None,
        None,
    )
    .await?;
    if !overview.get("cursor").is_some_and(Value::is_string) {
        return Err(WIRE_ERROR.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn factory_request(
    state: State<'_, FactoryBridge>,
    method: String,
    path: String,
    body: Option<Value>,
    idempotency_key: Option<String>,
    request_id: Option<String>,
) -> Result<Value, String> {
    route::validate(&method, &path)?;
    let method = if method == "POST" {
        Method::POST
    } else {
        Method::GET
    };
    let auth = state.connection.for_live()?;
    let future = json_request(
        &state.client,
        auth,
        method.clone(),
        &path,
        body,
        idempotency_key,
    );
    let Some(id) = request_id else {
        return future.await;
    };
    if method != Method::GET {
        return Err("工厂操作标识无效。".into());
    }
    let id = Uuid::parse_str(&id).map_err(|_| "工厂操作标识无效。")?;
    let (handle, registration) = AbortHandle::new_pair();
    {
        let mut reads = state.reads.lock().map_err(|_| WIRE_ERROR)?;
        if reads.contains_key(&id) {
            return Err("工厂请求标识重复。".into());
        }
        reads.insert(id, handle);
    }
    let result = Abortable::new(future, registration).await;
    state.reads.lock().map_err(|_| WIRE_ERROR)?.remove(&id);
    result.map_err(|_| "工厂查询已取消。".to_owned())?
}

#[tauri::command]
pub fn factory_cancel_read(
    state: State<'_, FactoryBridge>,
    request_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&request_id).map_err(|_| "工厂操作标识无效。")?;
    if let Some(handle) = state.reads.lock().map_err(|_| WIRE_ERROR)?.get(&id) {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn factory_preview_png(
    state: State<'_, FactoryBridge>,
    task_id: String,
    artifact_id: String,
) -> Result<tauri::ipc::Response, String> {
    let auth = state.connection.for_live()?;
    tauri::async_runtime::spawn_blocking(move || {
        download::preview_png(auth, &task_id, &artifact_id)
    })
    .await
    .map_err(|_| "归档图片读取中断。".to_owned())?
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn factory_download(
    app: tauri::AppHandle,
    state: State<'_, FactoryBridge>,
    task_id: String,
    artifact_id: String,
    file_name: String,
) -> Result<bool, String> {
    let auth = state.connection.for_live()?;
    tauri::async_runtime::spawn_blocking(move || {
        download::download(app, auth, task_id, artifact_id, file_name)
    })
    .await
    .map_err(|_| "交付物下载中断。".to_owned())?
}

#[tauri::command]
pub async fn factory_save_skill_file(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || download::save_skill_file(app, file_name, bytes))
        .await
        .map_err(|_| "随包文件保存中断。".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn stop_and_delete_map_only_approved_business_reasons() {
        let delete = "/v1/factory/agents/alpha/delete";
        let stop = "/v1/tasks/fixture/stop";
        let private = "private vault or server error";
        let version_conflict = operation_failure("/v1/factory/agents/alpha/versions/1.0.0/delete", StatusCode::CONFLICT,
            &serde_json::json!({"code":"agent_version_in_use","taskIds":["task-running","private task"],"debug":private})).unwrap();
        assert!(version_conflict.contains("task-running") && !version_conflict.contains("private"));
        let found = |path, status, code: &str, message: &str| {
            operation_failure(
                path,
                status,
                &serde_json::json!({"code":code,"message":message,"debug":private}),
            )
        };
        let active = found(delete, StatusCode::CONFLICT, "agent_in_use", private).unwrap();
        assert!(active.contains("未结束的工单") && !active.contains(private));
        assert!(
            found(delete, StatusCode::FORBIDDEN, "agent_protected", private)
                .unwrap()
                .contains("受中台保护")
        );
        assert!(
            found(
                delete,
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_delete_incomplete",
                private
            )
            .unwrap()
            .contains("删除尚未完成")
        );
        assert!(found(delete, StatusCode::CONFLICT, "private", private).is_none());
        assert!(found(delete, StatusCode::UNAUTHORIZED, "agent_protected", private).is_none());
        assert!(found(stop, StatusCode::CONFLICT, "agent_in_use", private).is_none());
        let release = "/v1/factory/releases";
        assert!(found(release, StatusCode::CONFLICT, "", private).is_none());
        assert!(
            found(
                release,
                StatusCode::CONFLICT,
                "",
                "该版本号已由其他发布或历史版本占用。"
            )
            .is_some()
        );
        for (next, accepted) in [("1.2.3", true), ("1.2.3 secret", false)] {
            let payload = serde_json::json!({"code":"assembly_version_too_low","nextVersion":next});
            assert_eq!(
                operation_failure("/v1/factory/assemblies", StatusCode::CONFLICT, &payload)
                    .is_some(),
                accepted
            );
        }
        assert!(
            found(stop, StatusCode::CONFLICT, "", "任务已经结束。")
                .unwrap()
                .contains("工单已经结束")
        );
        assert!(
            found(
                stop,
                StatusCode::CONFLICT,
                "",
                "节点管理服务未确认全部实例已停止，可重试停止任务。"
            )
            .unwrap()
            .contains("尚未确认停止")
        );
    }

    #[test]
    fn sends_authenticated_json_and_never_follows_or_echoes_redirects() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let thread = thread::spawn(move || {
            for response in [
                "HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"cursor\":\"ok\"}",
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 7\r\nConnection: close\r\n\r\nprivate",
            ] {
                let (mut stream, _) = server.accept().unwrap();
                let mut header = [0u8; 4096];
                let count = stream.read(&mut header).unwrap();
                let text = std::str::from_utf8(&header[..count])
                    .unwrap()
                    .to_ascii_lowercase();
                assert!(text.starts_with("get /v1/factory/overview http/1.1"));
                assert!(text.contains("authorization: bearer memory-fixture"));
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let bridge =
            FactoryBridge::new(Database::open(&directory.path().join("test.sqlite")).unwrap())
                .unwrap();
        tauri::async_runtime::block_on(async {
            let auth = || Auth {
                endpoint: origin.clone(),
                token: "memory-fixture".into(),
            };
            let overview = || {
                json_request(
                    &bridge.client,
                    auth(),
                    Method::GET,
                    "/v1/factory/overview",
                    None,
                    None,
                )
            };
            assert_eq!(overview().await.unwrap()["cursor"], "ok");
            let err = overview().await.unwrap_err();
            assert!(err.contains("302"));
            assert!(!err.contains("private") && !err.contains("memory-fixture"));
        });
        thread.join().unwrap();
    }
}
