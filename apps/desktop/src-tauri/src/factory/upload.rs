use super::{FactoryBridge, connection::Auth, public_status, transport_error};
use crate::{
    basket::{Basket, selected_file},
    codex::mime_type_for,
};
use reqwest::blocking::{Body, Client};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
    time::Duration,
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSummary {
    id: String,
    display_name: String,
    original_filename: String,
    media_type: String,
    size_bytes: u64,
    sha256: String,
    expires_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedUpload {
    display_name: String,
    status: &'static str,
    upload: Option<UploadSummary>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Envelope {
    upload: UploadSummary,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| "无法建立工厂附件连接。".into())
}
fn upload(
    client: &Client,
    auth: &Auth,
    display_name: &str,
    file: File,
    basket: Option<(&str, &str, &str)>,
) -> Result<UploadSummary, String> {
    let name = super::suggested_name(display_name);
    let size = file.metadata().map_err(|_| "无法读取附件大小。")?.len();
    let media = mime_type_for(Path::new(&name));
    let boundary = format!("qizhi-{}", Uuid::new_v4().simple());
    let head=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {media}\r\n\r\n").into_bytes();
    let tail = format!("\r\n--{boundary}--\r\n").into_bytes();
    let length = size
        .checked_add(head.len() as u64 + tail.len() as u64)
        .ok_or("附件过大。")?;
    let body = Cursor::new(head).chain(file).chain(Cursor::new(tail));
    let mut request = client
        .post(format!("{}/v1/task-inputs/uploads", auth.endpoint))
        .bearer_auth(&auth.token)
        .header("Accept", "application/json")
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::sized(body, length));
    if let Some((id, kind, _)) = basket {
        let source = match kind {
            "today" | "recent" | "local" => "qizhi_local_file",
            "ragflowChunk" => "ragflow_chunk",
            "ragflowDocument" => "ragflow_document",
            _ => return Err("未知的资料来源。".into()),
        };
        request = request
            .header("X-Qizhi-Basket-Id", id)
            .header("X-Qizhi-Source-Type", source);
    }
    let response = request.send().map_err(transport_error)?;
    let status = response.status();
    if status.as_u16() == 413 {
        return Err("附件超过工厂单文件限制，请减小文件后重新选择。".into());
    }
    public_status(status)?;
    let invalid = "工厂未确认附件，请重新上传。";
    let mut bytes = Vec::new();
    response
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid)?;
    if bytes.len() > 65536 {
        return Err(invalid.into());
    }
    let result: Envelope = serde_json::from_slice(&bytes).map_err(|_| invalid)?;
    let out = result.upload;
    if Uuid::parse_str(&out.id).is_err()
        || out.size_bytes != size
        || out.sha256.len() != 64
        || !out.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || basket.is_some_and(|(_, _, hash)| out.sha256 != hash)
        || chrono::DateTime::parse_from_rfc3339(&out.expires_at).is_err()
    {
        return Err(invalid.into());
    }
    Ok(out)
}
#[tauri::command]
pub async fn factory_upload_basket_item(
    item_id: String,
    state: State<'_, FactoryBridge>,
    basket: State<'_, Basket>,
) -> Result<UploadSummary, String> {
    let auth = state.connection.for_live()?;
    let basket = basket.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = basket.open(&item_id)?;
        let item = snapshot.item;
        upload(
            &client()?,
            &auth,
            &item.display_name,
            snapshot.file,
            Some((&item.id, &item.kind, &item.sha256)),
        )
    })
    .await
    .map_err(|_| "附件上传中断，请重试。".to_owned())?
}
#[tauri::command]
pub async fn factory_pick_uploads(
    app: tauri::AppHandle,
    state: State<'_, FactoryBridge>,
) -> Result<Vec<PickedUpload>, String> {
    let auth = state.connection.for_live()?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = client()?;
        let selected = app
            .dialog()
            .file()
            .blocking_pick_files()
            .unwrap_or_default();
        Ok(selected
            .into_iter()
            .map(|selected| {
                let mut name = "本地附件".to_owned();
                let result = (|| {
                    let path = selected.into_path().map_err(|_| "无法读取所选文件。")?;
                    name = super::suggested_name(
                        path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("本地附件"),
                    );
                    upload(&client, &auth, &name, selected_file(&path)?, None)
                })();
                match result {
                    Ok(upload) => PickedUpload {
                        display_name: name,
                        status: "uploaded",
                        upload: Some(upload),
                        error: None,
                    },
                    Err(error) => PickedUpload {
                        display_name: name,
                        status: "failed",
                        upload: None,
                        error: Some(error),
                    },
                }
            })
            .collect())
    })
    .await
    .map_err(|_| "附件上传中断，请重试。".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    fn native_upload_streams_one_real_file_and_marks_only_basket_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let data = b"fixture bytes\r\ninclude null:\0last";
        let hash = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(data));
        let remote_hash = hash.clone();
        let server = thread::spawn(move || {
            for index in 0..2 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    headers += &line;
                }
                let lower = headers.to_ascii_lowercase();
                assert!(lower.starts_with("post /v1/task-inputs/uploads"));
                assert!(lower.contains("authorization: bearer test-only"));
                assert_eq!(
                    lower.contains("x-qizhi-source-type: ragflow_chunk"),
                    index == 0
                );
                assert_eq!(lower.contains("x-qizhi-basket-id:"), index == 0);
                let n = lower
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .unwrap()
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                let mut body = vec![0; n];
                reader.read_exact(&mut body).unwrap();
                assert!(body.windows(data.len()).any(|window| window == data));
                assert!(
                    String::from_utf8_lossy(&body).contains("name=\"file\"; filename=\"研究.md\"")
                );
                let payload=serde_json::json!({"upload":{"id":Uuid::new_v4().to_string(),"displayName":"研究.md","originalFilename":"研究.md","sizeBytes":data.len(),"sha256":remote_hash,"mediaType":"text/markdown","expiresAt":"2027-04-05T00:00:00Z"}}).to_string();
                write!(
                    socket,
                    "HTTP/1.1 201 Created\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                )
                .unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("研究.md");
        std::fs::write(&path, data).unwrap();
        let client = client().unwrap();
        let auth = Auth {
            endpoint,
            token: "test-only".into(),
        };
        let item = Uuid::new_v4().to_string();
        for origin in [Some((item.as_str(), "ragflowChunk", hash.as_str())), None] {
            let result = upload(
                &client,
                &auth,
                "研究.md",
                selected_file(&path).unwrap(),
                origin,
            )
            .unwrap();
            assert_eq!(result.sha256, hash);
        }
        server.join().unwrap();
    }
}
