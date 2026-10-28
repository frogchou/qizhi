use std::{io::Write, process::Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::{
    config::{SecretStore, secret_store::WindowsCredentialStore},
    database::repositories::ConfigRepository,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowChat {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAnswer {
    pub answer: String,
    pub session_id: String,
}

#[derive(Deserialize)]
struct Envelope {
    code: i64,
    message: String,
    data: Value,
}

#[derive(Deserialize)]
struct ChatData {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct AnswerData {
    answer: Option<String>,
    #[serde(default)]
    session_id: String,
}

pub struct RagflowClient {
    base_url: Url,
    api_key: String,
}

impl RagflowClient {
    pub fn from_saved_config(
        configs: ConfigRepository,
        secrets: WindowsCredentialStore,
    ) -> Result<Self, String> {
        let config = configs
            .find("ragflow")
            .map_err(|_| "无法读取 RAGFlow 设置。".to_owned())?
            .ok_or_else(|| "请先在设置中保存 RAGFlow Base URL 和 API Key。".to_owned())?;
        let api_key = secrets
            .get(&config.credential_reference)
            .map_err(|_| "无法读取 RAGFlow API Key，请在设置中重新保存。".to_owned())?;
        Self::new(&config.endpoint, api_key)
    }

    pub fn new(endpoint: &str, api_key: String) -> Result<Self, String> {
        if api_key.trim().is_empty() || api_key.contains(['\r', '\n']) {
            return Err("RAGFlow API Key 无效。".to_owned());
        }
        let base_url =
            Url::parse(endpoint.trim()).map_err(|_| "RAGFlow Base URL 格式不正确。".to_owned())?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("RAGFlow Base URL 仅支持 HTTP 或 HTTPS。".to_owned());
        }
        Ok(Self { base_url, api_key })
    }

    pub fn list_chats(&self) -> Result<Vec<RagflowChat>, String> {
        let url = self.api_url("/api/v1/chats?page=1&page_size=100")?;
        Self::parse_chat_list(&self.request("GET", url, None)?)
    }

    pub fn ask(&self, chat_id: &str, question: &str) -> Result<RagflowAnswer, String> {
        if chat_id.trim().is_empty() || question.trim().is_empty() {
            return Err("请选择问答机器人并输入问题。".to_owned());
        }
        let body = serde_json::json!({
            "chat_id": chat_id,
            "stream": false,
            "messages": [{ "role": "user", "content": question }],
        })
        .to_string();
        let url = self.api_url("/api/v1/chat/completions")?;
        Self::parse_answer(&self.request("POST", url, Some(body))?)
    }

    pub fn parse_chat_list(body: &str) -> Result<Vec<RagflowChat>, String> {
        let envelope = parse_envelope(body)?;
        let chats = serde_json::from_value::<Vec<ChatData>>(envelope.data)
            .map_err(|_| "RAGFlow 返回的问答机器人列表无法识别。".to_owned())?;
        Ok(chats
            .into_iter()
            .map(|chat| RagflowChat {
                id: chat.id,
                name: chat.name,
                description: chat.description,
            })
            .collect())
    }

    pub fn parse_answer(body: &str) -> Result<RagflowAnswer, String> {
        let envelope = parse_envelope(body)?;
        let AnswerData { answer, session_id } = serde_json::from_value::<AnswerData>(envelope.data)
            .map_err(|_| "RAGFlow 返回的回答无法识别。".to_owned())?;
        let answer = answer
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "RAGFlow 未返回回答内容。".to_owned())?;
        Ok(RagflowAnswer { answer, session_id })
    }

    fn api_url(&self, suffix: &str) -> Result<String, String> {
        let mut url = self.base_url.clone();
        let (path, query) = suffix.split_once('?').unwrap_or((suffix, ""));
        let base_path = url.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}{path}"));
        url.set_query((!query.is_empty()).then_some(query));
        Ok(url.to_string())
    }

    fn request(&self, method: &str, url: String, body: Option<String>) -> Result<String, String> {
        let payload = serde_json::json!({
            "method": method,
            "url": url,
            "api_key": self.api_key,
            "body": body,
        })
        .to_string();
        let script = r#"
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$client = New-Object System.Net.Http.HttpClient
try {
  $client.Timeout = [TimeSpan]::FromSeconds(30)
  $request = New-Object System.Net.Http.HttpRequestMessage($payload.method, $payload.url)
  $request.Headers.TryAddWithoutValidation('Authorization', "Bearer $($payload.api_key)") | Out-Null
  if ($null -ne $payload.body) {
    $request.Content = New-Object System.Net.Http.StringContent($payload.body, [Text.Encoding]::UTF8, 'application/json')
  }
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $result = @{ status = [int]$response.StatusCode; body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } | ConvertTo-Json -Compress
  [Console]::Out.Write($result)
} finally {
  $client.Dispose()
}
"#;
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动 RAGFlow 网络请求。".to_owned())?;
        child
            .stdin
            .take()
            .ok_or_else(|| "无法安全发送 RAGFlow 请求。".to_owned())?
            .write_all(payload.as_bytes())
            .map_err(|_| "无法安全发送 RAGFlow 请求。".to_owned())?;
        let output = child
            .wait_with_output()
            .map_err(|_| "RAGFlow 请求未完成。".to_owned())?;
        if !output.status.success() {
            return Err("RAGFlow 请求未完成。".to_owned());
        }
        let transport = serde_json::from_slice::<TransportResult>(&output.stdout)
            .map_err(|_| "RAGFlow 返回了无法识别的网络响应。".to_owned())?;
        if !(200..300).contains(&transport.status) {
            return Err(format!("RAGFlow 连接未通过（HTTP {}）。", transport.status));
        }
        Ok(transport.body)
    }
}

#[derive(Deserialize)]
struct TransportResult {
    status: u16,
    body: String,
}

fn parse_envelope(body: &str) -> Result<Envelope, String> {
    let envelope = serde_json::from_str::<Envelope>(body)
        .map_err(|_| "RAGFlow 返回的数据无法识别。".to_owned())?;
    if envelope.code != 0 {
        return Err(format!("RAGFlow：{}", envelope.message));
    }
    Ok(envelope)
}
