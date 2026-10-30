use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::{
    config::{SecretStore, secret_store::WindowsCredentialStore},
    database::repositories::ConfigRepository,
    network::http::HttpClient,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowDataset {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgent {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowChunk {
    pub id: String,
    pub content: String,
    pub document_name: String,
    pub document_id: String,
    pub dataset_id: String,
    pub similarity: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentAnswer {
    pub agent_id: String,
    pub answer: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowUpload {
    pub document_ids: Vec<String>,
    pub document_count: usize,
    pub parsing_started: bool,
    pub parsing_error: Option<String>,
}

impl RagflowUpload {
    pub fn with_parsing_outcome(mut self, result: Result<(), String>) -> Self {
        match result {
            Ok(()) => self.parsing_started = true,
            Err(error) => self.parsing_error = Some(error),
        }
        self
    }
}

#[derive(Deserialize)]
struct Envelope {
    code: i64,
    #[serde(default)]
    message: String,
    #[serde(default)]
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
struct PagedChatData {
    #[serde(default)]
    chats: Vec<ChatData>,
}

#[derive(Deserialize)]
struct AnswerData {
    answer: Option<String>,
    #[serde(default)]
    session_id: String,
}

#[derive(Deserialize)]
struct DatasetData {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct AgentCanvasData {
    id: String,
    #[serde(rename = "type", default)]
    item_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct AgentPageData {
    #[serde(default)]
    canvas: Vec<AgentCanvasData>,
}

#[derive(Deserialize)]
struct RetrievalChunkData {
    id: String,
    content: String,
    #[serde(default)]
    document_keyword: String,
    #[serde(default)]
    docnm_kwd: String,
    #[serde(default)]
    document_id: String,
    #[serde(default)]
    dataset_id: String,
    #[serde(default)]
    similarity: f64,
}

#[derive(Deserialize)]
struct RetrievalData {
    #[serde(default)]
    chunks: Vec<RetrievalChunkData>,
}

#[derive(Deserialize)]
struct UploadedDocumentData {
    id: String,
}

#[derive(Clone)]
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

    pub fn list_datasets(&self) -> Result<Vec<RagflowDataset>, String> {
        let url = self.api_url("/api/v1/datasets?page=1&page_size=100")?;
        Self::parse_dataset_list(&self.request("GET", url, None)?)
    }

    pub fn list_agents(&self) -> Result<Vec<RagflowAgent>, String> {
        let url = self.api_url("/api/v1/agents?page=1&page_size=100")?;
        Self::parse_agent_list(&self.request("GET", url, None)?)
    }

    pub fn retrieve(
        &self,
        question: &str,
        dataset_ids: Vec<String>,
    ) -> Result<Vec<RagflowChunk>, String> {
        if question.trim().is_empty() || dataset_ids.is_empty() {
            return Err("请选择至少一个知识库并输入关键词。".to_owned());
        }
        let body = serde_json::json!({
            "question": question,
            "dataset_ids": dataset_ids,
            "page": 1,
            "page_size": 10,
            "highlight": true,
        })
        .to_string();
        let url = self.api_url("/api/v1/retrieval")?;
        Self::parse_retrieval(&self.request("POST", url, Some(body))?)
    }

    pub fn ask_agent(&self, agent_id: &str, question: &str) -> Result<RagflowAgentAnswer, String> {
        if agent_id.trim().is_empty() || question.trim().is_empty() {
            return Err("请选择 Agent 并输入问题。".to_owned());
        }
        let body = serde_json::json!({
            "agent_id": agent_id,
            "question": question,
            "stream": false,
        })
        .to_string();
        let url = self.api_url("/api/v1/agents/chat/completions")?;
        Self::parse_agent_answer(
            agent_id,
            &self.request_with_timeout("POST", url, Some(body), Self::agent_request_timeout())?,
        )
    }

    pub fn download_document(
        &self,
        dataset_id: &str,
        document_id: &str,
    ) -> Result<Vec<u8>, String> {
        if !is_resource_id(dataset_id) || !is_resource_id(document_id) {
            return Err("RAGFlow 文档标识无效，无法下载。".to_owned());
        }
        let url = self.api_url(&format!(
            "/api/v1/datasets/{dataset_id}/documents/{document_id}"
        ))?;
        let transport = HttpClient::with_timeout(Duration::from_secs(90))?.request_bearer_bytes(
            reqwest::Method::GET,
            &url,
            &self.api_key,
        )?;
        if !(200..300).contains(&transport.status) {
            return Err(format!("RAGFlow 下载未通过（HTTP {}）。", transport.status));
        }
        if transport.body.is_empty() {
            return Err("RAGFlow 未返回可下载的文件。".to_owned());
        }
        Ok(transport.body)
    }

    pub fn upload_document(
        &self,
        file_path: &Path,
        dataset_id: &str,
        parent_path: Option<&str>,
        start_parsing: bool,
    ) -> Result<RagflowUpload, String> {
        if !is_resource_id(dataset_id) {
            return Err("目标知识库无效。".to_owned());
        }
        let file_name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "无法读取文件名。".to_owned())?;
        if contains_multipart_control(file_name) {
            return Err("文件名包含不支持的字符。".to_owned());
        }
        let file_bytes = std::fs::read(file_path)
            .map_err(|_| "无法读取要上传的文件，它可能已移动或没有访问权限。".to_owned())?;
        let parent_path = parent_path.map(str::trim).filter(|value| !value.is_empty());
        if parent_path.is_some_and(contains_multipart_control) {
            return Err("知识库内目录包含不支持的字符。".to_owned());
        }
        let boundary = upload_boundary();
        let body = build_upload_body(&boundary, file_name, &file_bytes, parent_path);
        let url = self.api_url(&format!("/api/v1/datasets/{dataset_id}/documents"))?;
        let transport = HttpClient::with_timeout(Duration::from_secs(120))?
            .request_bearer_multipart(&url, &self.api_key, &boundary, body)?;
        if !(200..300).contains(&transport.status) {
            return Err(format!("RAGFlow 上传未通过（HTTP {}）。", transport.status));
        }
        let mut upload = Self::parse_upload_response(&transport.body)?;
        if start_parsing {
            let parsing_result = self.start_parsing(dataset_id, &upload.document_ids);
            upload = upload.with_parsing_outcome(parsing_result);
        }
        Ok(upload)
    }

    pub fn start_parsing(&self, dataset_id: &str, document_ids: &[String]) -> Result<(), String> {
        if !is_resource_id(dataset_id)
            || document_ids.is_empty()
            || !document_ids.iter().all(|id| is_resource_id(id))
        {
            return Err("RAGFlow 上传未返回可解析的文档。".to_owned());
        }
        let url = self.api_url(&format!("/api/v1/datasets/{dataset_id}/chunks"))?;
        let body = serde_json::json!({ "document_ids": document_ids }).to_string();
        Self::parse_parse_action_response(&self.request("POST", url, Some(body))?)
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
        // RAGFlow's current endpoint returns data as { chats, total }. Keep the
        // array form as a compatibility path for older RAGFlow deployments.
        let chats = match envelope.data {
            Value::Array(items) => serde_json::from_value::<Vec<ChatData>>(Value::Array(items)),
            data => serde_json::from_value::<PagedChatData>(data).map(|page| page.chats),
        }
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

    pub fn parse_dataset_list(body: &str) -> Result<Vec<RagflowDataset>, String> {
        let envelope = parse_envelope(body)?;
        let datasets = serde_json::from_value::<Vec<DatasetData>>(envelope.data)
            .map_err(|_| "RAGFlow 返回的知识库列表无法识别。".to_owned())?;
        Ok(datasets
            .into_iter()
            .map(|dataset| RagflowDataset {
                id: dataset.id,
                name: dataset.name,
                description: dataset.description.unwrap_or_default(),
            })
            .collect())
    }

    pub fn parse_upload_response(body: &str) -> Result<RagflowUpload, String> {
        let envelope = parse_envelope(body)?;
        let documents = match envelope.data {
            Value::Array(items) => {
                serde_json::from_value::<Vec<UploadedDocumentData>>(Value::Array(items))
            }
            data => serde_json::from_value::<UploadedDocumentData>(data).map(|item| vec![item]),
        }
        .map_err(|_| "RAGFlow 上传返回的数据无法识别。".to_owned())?;
        let document_ids = documents
            .into_iter()
            .map(|item| item.id)
            .filter(|id| is_resource_id(id))
            .collect::<Vec<_>>();
        if document_ids.is_empty() {
            return Err("RAGFlow 上传未返回可解析的文档。".to_owned());
        }
        let document_count = document_ids.len();
        Ok(RagflowUpload {
            document_ids,
            document_count,
            parsing_started: false,
            parsing_error: None,
        })
    }

    pub fn parse_parse_action_response(body: &str) -> Result<(), String> {
        parse_envelope(body).map(|_| ())
    }

    pub fn parse_agent_list(body: &str) -> Result<Vec<RagflowAgent>, String> {
        let envelope = parse_envelope(body)?;
        let page = serde_json::from_value::<AgentPageData>(envelope.data)
            .map_err(|_| "RAGFlow 返回的 Agents 列表无法识别。".to_owned())?;
        Ok(page
            .canvas
            .into_iter()
            .filter(|item| item.item_type.is_empty() || item.item_type == "agent")
            .map(|item| RagflowAgent {
                id: item.id,
                name: if item.title.is_empty() {
                    item.name
                } else {
                    item.title
                },
                description: item.description.unwrap_or_default(),
            })
            .collect())
    }

    pub fn parse_retrieval(body: &str) -> Result<Vec<RagflowChunk>, String> {
        let envelope = parse_envelope(body)?;
        let data = serde_json::from_value::<RetrievalData>(envelope.data)
            .map_err(|_| "RAGFlow 返回的检索结果无法识别。".to_owned())?;
        Ok(data
            .chunks
            .into_iter()
            .map(|chunk| RagflowChunk {
                id: chunk.id,
                content: chunk.content,
                document_name: if chunk.document_keyword.is_empty() {
                    chunk.docnm_kwd
                } else {
                    chunk.document_keyword
                },
                document_id: chunk.document_id,
                dataset_id: chunk.dataset_id,
                similarity: chunk.similarity,
            })
            .collect())
    }

    pub fn parse_agent_answer(agent_id: &str, body: &str) -> Result<RagflowAgentAnswer, String> {
        let envelope = parse_envelope(body).map_err(agent_execution_error)?;
        let session_id = envelope
            .data
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let answer = envelope
            .data
            .get("data")
            .and_then(|data| data.get("content"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "RAGFlow Agent 未返回回答内容。".to_owned())?
            .to_owned();
        Ok(RagflowAgentAnswer {
            agent_id: agent_id.to_owned(),
            answer,
            session_id,
        })
    }

    pub fn agent_request_timeout() -> Duration {
        Duration::from_secs(120)
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
        self.request_with_timeout(method, url, body, Duration::from_secs(30))
    }

    fn request_with_timeout(
        &self,
        method: &str,
        url: String,
        body: Option<String>,
        timeout: Duration,
    ) -> Result<String, String> {
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| "RAGFlow 请求方法无效。".to_owned())?;
        let transport =
            HttpClient::with_timeout(timeout)?.request_bearer(method, &url, &self.api_key, body)?;
        if !(200..300).contains(&transport.status) {
            return Err(format!("RAGFlow 连接未通过（HTTP {}）。", transport.status));
        }
        Ok(transport.body)
    }
}

fn is_resource_id(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains(['/', '\\', '\0'])
}

fn contains_multipart_control(value: &str) -> bool {
    value.contains(['\r', '\n', '\0'])
}

fn upload_boundary() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("qizhi-{timestamp:x}")
}

fn build_upload_body(
    boundary: &str,
    file_name: &str,
    file_bytes: &[u8],
    parent_path: Option<&str>,
) -> Vec<u8> {
    let mut body = Vec::with_capacity(file_bytes.len() + 512);
    let write_text = |body: &mut Vec<u8>, value: &str| body.extend_from_slice(value.as_bytes());
    write_text(&mut body, &format!("--{boundary}\r\n"));
    write_text(
        &mut body,
        &format!("Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n"),
    );
    write_text(&mut body, "Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(file_bytes);
    write_text(&mut body, "\r\n");
    if let Some(parent_path) = parent_path {
        write_text(&mut body, &format!("--{boundary}\r\n"));
        write_text(
            &mut body,
            "Content-Disposition: form-data; name=\"parent_path\"\r\n\r\n",
        );
        write_text(&mut body, parent_path);
        write_text(&mut body, "\r\n");
    }
    write_text(&mut body, &format!("--{boundary}--\r\n"));
    body
}

fn agent_execution_error(error: String) -> String {
    if error.contains("Base URL") {
        "所选 Agent 无法连接其配置的大模型服务，请在 RAGFlow 中检查该 Agent 的模型 Base URL、密钥和代理设置。"
            .to_owned()
    } else {
        error
    }
}

fn parse_envelope(body: &str) -> Result<Envelope, String> {
    let envelope = serde_json::from_str::<Envelope>(body)
        .map_err(|_| "RAGFlow 返回的数据无法识别。".to_owned())?;
    if envelope.code != 0 {
        return Err(format!("RAGFlow：{}", envelope.message));
    }
    Ok(envelope)
}

#[cfg(test)]
mod transport_tests {
    #[test]
    fn ragflow_transport_never_starts_a_shell_process() {
        let source = include_str!("client.rs").to_ascii_lowercase();
        assert!(!source.contains(&["power", "shell.exe"].concat()));
        assert!(!source.contains(&["command", "::new"].concat()));
    }
}
