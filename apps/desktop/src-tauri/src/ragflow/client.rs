use std::{
    collections::BTreeMap,
    fs::File,
    io::{Cursor, Read},
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentReference {
    pub citation_id: String,
    pub chunk_id: String,
    pub content: String,
    pub document_name: String,
    pub document_id: String,
    pub dataset_id: String,
    pub similarity: f64,
    pub doc_type: String,
    pub positions: Value,
    pub document_metadata: Value,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentSource {
    pub document_name: String,
    pub document_id: String,
    pub dataset_id: String,
    pub citation_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentAnswer {
    pub agent_id: String,
    pub answer: String,
    pub session_id: String,
    pub references: Vec<RagflowAgentReference>,
    pub sources: Vec<RagflowAgentSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowAgentStep {
    pub title: String,
    pub node_type: String,
    pub status: String,
    pub elapsed_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RagflowAgentStreamEvent {
    AnswerReset {
        message_id: String,
    },
    Delta {
        delta: String,
    },
    Thinking {
        active: bool,
    },
    Step(RagflowAgentStep),
    References {
        references: Vec<RagflowAgentReference>,
        sources: Vec<RagflowAgentSource>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagflowUpload {
    pub document_ids: Vec<String>,
    pub document_count: usize,
    pub parsing_started: bool,
    pub parsing_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RagflowUploadFailure {
    BeforeRequest(String),
    Rejected(String),
    Uncertain(String),
}

impl RagflowUploadFailure {
    pub fn message(self) -> String {
        match self {
            Self::BeforeRequest(message) | Self::Rejected(message) | Self::Uncertain(message) => {
                message
            }
        }
    }
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

    pub fn ask_agent_streaming<F>(
        &self,
        agent_id: &str,
        question: &str,
        session_id: Option<&str>,
        mut on_event: F,
    ) -> Result<RagflowAgentAnswer, String>
    where
        F: FnMut(RagflowAgentStreamEvent) -> Result<(), String>,
    {
        if agent_id.trim().is_empty() || question.trim().is_empty() {
            return Err("请选择 Agent 并输入问题。".to_owned());
        }
        let mut body = serde_json::json!({
            "agent_id": agent_id,
            "question": question,
            "stream": true,
            "return_trace": true,
            "chat_template_kwargs": { "enable_thinking": false },
        });
        if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
            body["session_id"] = Value::String(session_id.to_owned());
        }
        let url = self.api_url("/api/v1/agents/chat/completions")?;
        let mut decoder = AgentStreamDecoder::new(agent_id);
        let mut frame = Vec::<String>::new();
        let mut saw_sse = false;
        let transport = HttpClient::with_timeout(Duration::from_secs(300))?.request_bearer_lines(
            reqwest::Method::POST,
            &url,
            &self.api_key,
            Some(body.to_string()),
            |line| {
                let line = line.trim_end_matches('\r');
                if line.starts_with("data:") || line.starts_with("event:") || line.starts_with(':')
                {
                    saw_sse = true;
                }
                if !saw_sse {
                    return Ok(());
                }
                if line.is_empty() {
                    decoder.consume_frame(&frame.join("\n"))?;
                    frame.clear();
                    for event in decoder.take_events() {
                        on_event(event)?;
                    }
                } else {
                    frame.push(line.to_owned());
                }
                Ok(())
            },
        )?;
        if !(200..300).contains(&transport.status) {
            return Err(format!("RAGFlow 连接未通过（HTTP {}）。", transport.status));
        }
        if !saw_sse {
            let (answer, events) = Self::decode_agent_stream(agent_id, &transport.body)?;
            for event in events {
                on_event(event)?;
            }
            return Ok(answer);
        }
        if !frame.is_empty() {
            decoder.consume_frame(&frame.join("\n"))?;
        }
        for event in decoder.take_events() {
            on_event(event)?;
        }
        decoder.finish().map(|(answer, _)| answer)
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
        self.upload_document_with_outcome(file_path, dataset_id, parent_path, start_parsing)
            .map_err(RagflowUploadFailure::message)
    }

    pub fn upload_document_with_outcome(
        &self,
        file_path: &Path,
        dataset_id: &str,
        parent_path: Option<&str>,
        start_parsing: bool,
    ) -> Result<RagflowUpload, RagflowUploadFailure> {
        if !is_resource_id(dataset_id) {
            return Err(RagflowUploadFailure::BeforeRequest(
                "目标知识库无效。".to_owned(),
            ));
        }
        let file_name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| RagflowUploadFailure::BeforeRequest("无法读取文件名。".to_owned()))?;
        if contains_multipart_control(file_name) {
            return Err(RagflowUploadFailure::BeforeRequest(
                "文件名包含不支持的字符。".to_owned(),
            ));
        }
        let parent_path = parent_path.map(str::trim).filter(|value| !value.is_empty());
        if parent_path.is_some_and(contains_multipart_control) {
            return Err(RagflowUploadFailure::BeforeRequest(
                "知识库内目录包含不支持的字符。".to_owned(),
            ));
        }
        let boundary = upload_boundary();
        let (body, content_length) =
            build_upload_body(&boundary, file_name, file_path, parent_path)
                .map_err(RagflowUploadFailure::BeforeRequest)?;
        let url = self
            .api_url(&format!("/api/v1/datasets/{dataset_id}/documents"))
            .map_err(RagflowUploadFailure::BeforeRequest)?;
        let client = HttpClient::with_timeout(Duration::from_secs(120))
            .map_err(RagflowUploadFailure::BeforeRequest)?;
        let transport = client
            .request_bearer_multipart(&url, &self.api_key, &boundary, body, content_length)
            .map_err(RagflowUploadFailure::Uncertain)?;
        if !(200..300).contains(&transport.status) {
            return Err(RagflowUploadFailure::Rejected(format!(
                "RAGFlow 上传未通过（HTTP {}）。",
                transport.status
            )));
        }
        let mut upload = Self::parse_upload_response_after_success(&transport.body)?;
        if start_parsing {
            let parsing_result = self.start_parsing(dataset_id, &upload.document_ids);
            upload = upload.with_parsing_outcome(parsing_result);
        }
        Ok(upload)
    }

    pub fn upload_markdown(
        &self,
        file_name: &str,
        markdown: &[u8],
        dataset_id: &str,
        parent_path: Option<&str>,
        start_parsing: bool,
    ) -> Result<RagflowUpload, String> {
        if !is_resource_id(dataset_id) || file_name.trim().is_empty() || markdown.is_empty() {
            return Err("总结文件或目标知识库无效。".to_owned());
        }
        if contains_multipart_control(file_name) {
            return Err("文件名包含不支持的字符。".to_owned());
        }
        let parent_path = parent_path.map(str::trim).filter(|value| !value.is_empty());
        if parent_path.is_some_and(contains_multipart_control) {
            return Err("知识库内目录包含不支持的字符。".to_owned());
        }
        let boundary = upload_boundary();
        let (body, content_length) =
            build_upload_bytes(&boundary, file_name, markdown, parent_path)?;
        let url = self.api_url(&format!("/api/v1/datasets/{dataset_id}/documents"))?;
        let transport = HttpClient::with_timeout(Duration::from_secs(120))?
            .request_bearer_multipart(&url, &self.api_key, &boundary, body, content_length)?;
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

    fn parse_upload_response_after_success(
        body: &str,
    ) -> Result<RagflowUpload, RagflowUploadFailure> {
        let envelope = serde_json::from_str::<Envelope>(body).map_err(|_| {
            RagflowUploadFailure::Uncertain("RAGFlow 上传返回的数据无法识别。".to_owned())
        })?;
        if envelope.code != 0 {
            return Err(RagflowUploadFailure::Rejected(
                if envelope.message.is_empty() {
                    format!("RAGFlow 拒绝了上传请求（业务码 {}）。", envelope.code)
                } else {
                    envelope.message
                },
            ));
        }
        let documents = match envelope.data {
            Value::Array(items) => {
                serde_json::from_value::<Vec<UploadedDocumentData>>(Value::Array(items))
            }
            data => serde_json::from_value::<UploadedDocumentData>(data).map(|item| vec![item]),
        }
        .map_err(|_| {
            RagflowUploadFailure::Uncertain("RAGFlow 上传返回的数据无法识别。".to_owned())
        })?;
        let document_ids = documents
            .into_iter()
            .map(|item| item.id)
            .filter(|id| is_resource_id(id))
            .collect::<Vec<_>>();
        if document_ids.is_empty() {
            return Err(RagflowUploadFailure::Uncertain(
                "RAGFlow 上传未返回可确认的文档标识。".to_owned(),
            ));
        }
        Ok(RagflowUpload {
            document_count: document_ids.len(),
            document_ids,
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
        let payload = envelope.data.get("data").unwrap_or(&envelope.data);
        let answer = payload
            .get("content")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "RAGFlow Agent 未返回回答内容。".to_owned())?
            .to_owned();
        let (references, sources) = payload
            .get("reference")
            .map(parse_agent_reference_bundle)
            .unwrap_or_default();
        Ok(RagflowAgentAnswer {
            agent_id: agent_id.to_owned(),
            answer,
            session_id,
            references,
            sources,
        })
    }

    pub fn decode_agent_stream(
        agent_id: &str,
        body: &str,
    ) -> Result<(RagflowAgentAnswer, Vec<RagflowAgentStreamEvent>), String> {
        if !body.trim_start().starts_with("data:")
            && !body.trim_start().starts_with("event:")
            && !body.trim_start().starts_with(':')
        {
            let answer = Self::parse_agent_answer(agent_id, body)?;
            let delta = RagflowAgentStreamEvent::Delta {
                delta: answer.answer.clone(),
            };
            return Ok((answer, vec![delta]));
        }

        let mut decoder = AgentStreamDecoder::new(agent_id);
        let normalized = body.replace("\r\n", "\n");
        for frame in normalized.split("\n\n") {
            decoder.consume_frame(frame)?;
        }
        decoder.finish()
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

struct AgentStreamDecoder {
    agent_id: String,
    active_message_id: Option<String>,
    raw_message_content: String,
    marker_buffer: String,
    answer: String,
    session_id: String,
    references: Vec<RagflowAgentReference>,
    sources: Vec<RagflowAgentSource>,
    thinking: bool,
    done: bool,
    events: Vec<RagflowAgentStreamEvent>,
}

impl AgentStreamDecoder {
    fn new(agent_id: &str) -> Self {
        Self {
            agent_id: agent_id.to_owned(),
            active_message_id: None,
            raw_message_content: String::new(),
            marker_buffer: String::new(),
            answer: String::new(),
            session_id: String::new(),
            references: Vec::new(),
            sources: Vec::new(),
            thinking: false,
            done: false,
            events: Vec::new(),
        }
    }

    fn consume(&mut self, event_name: Option<&str>, data: &str) -> Result<(), String> {
        let value: Value =
            serde_json::from_str(data).map_err(|_| "RAGFlow 返回的数据无法识别。".to_owned())?;
        if value
            .get("code")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent 执行失败");
            return Err(agent_execution_error(format!("RAGFlow：{message}")));
        }
        if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
            self.session_id = session_id.to_owned();
        }
        let kind = value
            .get("event")
            .or_else(|| value.get("type"))
            .and_then(Value::as_str)
            .or(event_name)
            .unwrap_or_default();
        let message_data = value.get("data").unwrap_or(&value);
        if message_data
            .get("start_to_think")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            self.set_thinking(true);
        }
        if message_data
            .get("end_to_think")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            self.set_thinking(false);
        }
        match kind {
            "start_to_think" => self.set_thinking(true),
            "end_to_think" => self.set_thinking(false),
            "message_end" | "message_completed" => {
                if let Some(reference) = message_data.get("reference") {
                    let (references, sources) = parse_agent_reference_bundle(reference);
                    if !references.is_empty() || !sources.is_empty() {
                        self.references = references.clone();
                        self.sources = sources.clone();
                        self.events.push(RagflowAgentStreamEvent::References {
                            references,
                            sources,
                        });
                    }
                }
                self.done = true;
            }
            "node_finished" | "component_finished" => {
                let data = value.get("data").unwrap_or(&value);
                self.events
                    .push(RagflowAgentStreamEvent::Step(safe_step(data)));
            }
            "message" => self.consume_message(&value),
            "error" => {
                let message = value
                    .get("message")
                    .or_else(|| value.pointer("/data/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Agent 执行失败");
                return Err(agent_execution_error(message.to_owned()));
            }
            _ => {}
        }
        Ok(())
    }

    fn consume_frame(&mut self, frame: &str) -> Result<(), String> {
        let mut data_lines = Vec::new();
        let mut event_name = None;
        for line in frame.lines() {
            if line.starts_with(':') || line.trim().is_empty() {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event_name = Some(value.trim());
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start());
            }
        }
        if data_lines.is_empty() {
            return Ok(());
        }
        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        self.consume(event_name, &data)
    }

    fn take_events(&mut self) -> Vec<RagflowAgentStreamEvent> {
        std::mem::take(&mut self.events)
    }

    fn consume_message(&mut self, value: &Value) {
        let message_id = value
            .get("message_id")
            .or_else(|| value.pointer("/data/message_id"))
            .and_then(Value::as_str)
            .unwrap_or("message")
            .to_owned();
        if self.active_message_id.as_deref() != Some(&message_id) {
            if self.active_message_id.is_some() {
                self.answer.clear();
                self.marker_buffer.clear();
                self.raw_message_content.clear();
                self.set_thinking(false);
                self.events.push(RagflowAgentStreamEvent::AnswerReset {
                    message_id: message_id.clone(),
                });
            }
            self.active_message_id = Some(message_id);
        }
        let content = value
            .pointer("/data/content")
            .or_else(|| value.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let delta = if content.starts_with(&self.raw_message_content) {
            let delta = content[self.raw_message_content.len()..].to_owned();
            self.raw_message_content.clear();
            self.raw_message_content.push_str(content);
            delta
        } else {
            self.raw_message_content.push_str(content);
            content.to_owned()
        };
        self.consume_content(&delta);
    }

    fn consume_content(&mut self, content: &str) {
        self.marker_buffer.push_str(content);
        loop {
            let marker = if self.thinking { "</think>" } else { "<think>" };
            if let Some(index) = self.marker_buffer.find(marker) {
                if !self.thinking {
                    let safe = self.marker_buffer[..index].to_owned();
                    self.push_answer(&safe);
                }
                self.marker_buffer.drain(..index + marker.len());
                self.set_thinking(!self.thinking);
                continue;
            }

            let keep = longest_marker_prefix_suffix(&self.marker_buffer, marker);
            let emit_until = self.marker_buffer.len().saturating_sub(keep);
            if emit_until > 0 {
                if !self.thinking {
                    let safe = self.marker_buffer[..emit_until].to_owned();
                    self.push_answer(&safe);
                }
                self.marker_buffer.drain(..emit_until);
            }
            return;
        }
    }

    fn push_answer(&mut self, content: &str) {
        if content.is_empty() {
            return;
        }
        let delta = if content.starts_with(&self.answer) {
            &content[self.answer.len()..]
        } else {
            content
        };
        if delta.is_empty() {
            return;
        }
        self.answer.push_str(delta);
        self.events.push(RagflowAgentStreamEvent::Delta {
            delta: delta.to_owned(),
        });
    }

    fn set_thinking(&mut self, active: bool) {
        if self.thinking != active {
            self.thinking = active;
            self.events
                .push(RagflowAgentStreamEvent::Thinking { active });
        }
    }

    fn finish(self) -> Result<(RagflowAgentAnswer, Vec<RagflowAgentStreamEvent>), String> {
        if !self.done {
            return Err("RAGFlow Agent 流式回答中断，已保留已接收内容。".to_owned());
        }
        if self.thinking || !self.marker_buffer.is_empty() {
            return Err("RAGFlow Agent 未返回可安全展示的回答内容。".to_owned());
        }
        if self.answer.trim().is_empty() {
            return Err("RAGFlow Agent 未返回可安全展示的回答内容。".to_owned());
        }
        Ok((
            RagflowAgentAnswer {
                agent_id: self.agent_id,
                answer: self.answer,
                session_id: self.session_id,
                references: self.references,
                sources: self.sources,
            },
            self.events,
        ))
    }
}

fn parse_agent_reference_bundle(
    reference: &Value,
) -> (Vec<RagflowAgentReference>, Vec<RagflowAgentSource>) {
    let references = match reference.get("chunks") {
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, chunk)| parse_agent_reference(index.to_string(), chunk))
            .collect::<Vec<_>>(),
        Some(Value::Object(items)) => items
            .iter()
            .map(|(citation_id, chunk)| parse_agent_reference(citation_id.clone(), chunk))
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };

    let mut sources = reference
        .get("doc_aggs")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(fallback_name, source)| {
                    let document_id = value_as_string(source.get("doc_id"));
                    let document_name = value_as_string(source.get("doc_name"));
                    let document_name = if document_name.is_empty() {
                        fallback_name.clone()
                    } else {
                        document_name
                    };
                    if document_id.is_empty() && document_name.is_empty() {
                        return None;
                    }
                    let dataset_id = references
                        .iter()
                        .find(|citation| {
                            (!document_id.is_empty() && citation.document_id == document_id)
                                || (document_id.is_empty()
                                    && citation.document_name == document_name)
                        })
                        .map(|citation| citation.dataset_id.clone())
                        .unwrap_or_default();
                    let citation_count = source
                        .get("count")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or_else(|| {
                            references
                                .iter()
                                .filter(|citation| {
                                    (!document_id.is_empty() && citation.document_id == document_id)
                                        || (document_id.is_empty()
                                            && citation.document_name == document_name)
                                })
                                .count()
                        });
                    Some(RagflowAgentSource {
                        document_name,
                        document_id,
                        dataset_id,
                        citation_count,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if sources.is_empty() {
        let mut grouped = BTreeMap::<(String, String, String), usize>::new();
        for citation in &references {
            *grouped
                .entry((
                    citation.document_id.clone(),
                    citation.document_name.clone(),
                    citation.dataset_id.clone(),
                ))
                .or_default() += 1;
        }
        sources = grouped
            .into_iter()
            .map(
                |((document_id, document_name, dataset_id), citation_count)| RagflowAgentSource {
                    document_name,
                    document_id,
                    dataset_id,
                    citation_count,
                },
            )
            .collect();
    }

    (references, sources)
}

fn parse_agent_reference(citation_id: String, chunk: &Value) -> RagflowAgentReference {
    RagflowAgentReference {
        citation_id,
        chunk_id: value_as_string(chunk.get("id")),
        content: value_as_string(chunk.get("content")),
        document_name: value_as_string(
            chunk
                .get("document_name")
                .or_else(|| chunk.get("document_keyword"))
                .or_else(|| chunk.get("docnm_kwd")),
        ),
        document_id: value_as_string(chunk.get("document_id")),
        dataset_id: value_as_string(chunk.get("dataset_id")),
        similarity: chunk
            .get("similarity")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
        doc_type: value_as_string(chunk.get("doc_type")),
        positions: chunk.get("positions").cloned().unwrap_or(Value::Null),
        document_metadata: chunk
            .get("document_metadata")
            .cloned()
            .unwrap_or(Value::Null),
        url: value_as_string(chunk.get("url")),
    }
}

fn value_as_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn longest_marker_prefix_suffix(value: &str, marker: &str) -> usize {
    (1..marker.len())
        .rev()
        .find(|length| value.ends_with(&marker[..*length]))
        .unwrap_or(0)
}

fn safe_step(value: &Value) -> RagflowAgentStep {
    let title = value
        .get("title")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("执行节点");
    let node_type = value
        .get("node_type")
        .or_else(|| value.get("component_type"))
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("node");
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    let elapsed_ms = value
        .get("elapsed_time")
        .or_else(|| value.get("elapsed"))
        .and_then(Value::as_f64)
        .map(|seconds| (seconds.max(0.0) * 1000.0).round() as u64);
    let error = value
        .get("error")
        .and_then(Value::as_str)
        .map(redact_trace_text)
        .filter(|text| !text.is_empty());
    RagflowAgentStep {
        title: redact_trace_text(title),
        node_type: redact_trace_text(node_type),
        status: redact_trace_text(status),
        elapsed_ms,
        error,
    }
}

fn truncate_trace_text(value: &str) -> String {
    value.chars().take(240).collect()
}

fn redact_trace_text(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let sensitive_markers = [
        "authorization",
        "bearer ",
        "api_key",
        "api-key",
        "apikey",
        "password",
        "secret",
        "token",
        "key=",
        "sk-",
    ];
    if sensitive_markers
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return "[已脱敏]".to_owned();
    }
    truncate_trace_text(value)
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

enum MultipartSegment {
    Bytes(Cursor<Vec<u8>>),
    File(File),
}

struct MultipartUploadBody {
    segments: Vec<MultipartSegment>,
    current_segment: usize,
}

impl Read for MultipartUploadBody {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        while self.current_segment < self.segments.len() {
            let count = match &mut self.segments[self.current_segment] {
                MultipartSegment::Bytes(bytes) => bytes.read(buffer),
                MultipartSegment::File(file) => file.read(buffer),
            }?;
            if count != 0 {
                return Ok(count);
            }
            self.current_segment += 1;
        }
        Ok(0)
    }
}

fn push_multipart_text(
    segments: &mut Vec<MultipartSegment>,
    length: &mut u64,
    text: String,
) -> Result<(), String> {
    *length = length
        .checked_add(text.len() as u64)
        .ok_or_else(|| "要上传的文件过大。".to_owned())?;
    segments.push(MultipartSegment::Bytes(Cursor::new(text.into_bytes())));
    Ok(())
}

fn build_upload_body(
    boundary: &str,
    file_name: &str,
    file_path: &Path,
    parent_path: Option<&str>,
) -> Result<(MultipartUploadBody, u64), String> {
    let file = File::open(file_path)
        .map_err(|_| "无法读取要上传的文件，它可能已移动或没有访问权限。".to_owned())?;
    let file_size = file
        .metadata()
        .map_err(|_| "无法读取要上传的文件，它可能已移动或没有访问权限。".to_owned())?
        .len();
    let mut segments = Vec::new();
    let mut length = 0_u64;
    push_multipart_text(
        &mut segments,
        &mut length,
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        ),
    )?;
    length = length
        .checked_add(file_size)
        .ok_or_else(|| "要上传的文件过大。".to_owned())?;
    segments.push(MultipartSegment::File(file));
    push_multipart_text(&mut segments, &mut length, "\r\n".to_owned())?;
    if let Some(parent_path) = parent_path {
        push_multipart_text(
            &mut segments,
            &mut length,
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"parent_path\"\r\n\r\n{parent_path}\r\n"
            ),
        )?;
    }
    push_multipart_text(&mut segments, &mut length, format!("--{boundary}--\r\n"))?;
    Ok((
        MultipartUploadBody {
            segments,
            current_segment: 0,
        },
        length,
    ))
}

fn build_upload_bytes(
    boundary: &str,
    file_name: &str,
    bytes: &[u8],
    parent_path: Option<&str>,
) -> Result<(MultipartUploadBody, u64), String> {
    let mut segments = Vec::new();
    let mut length = 0_u64;
    push_multipart_text(
        &mut segments,
        &mut length,
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: text/markdown; charset=utf-8\r\n\r\n"
        ),
    )?;
    length = length
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "总结内容过大。".to_owned())?;
    segments.push(MultipartSegment::Bytes(Cursor::new(bytes.to_vec())));
    push_multipart_text(&mut segments, &mut length, "\r\n".to_owned())?;
    if let Some(parent_path) = parent_path {
        push_multipart_text(
            &mut segments,
            &mut length,
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"parent_path\"\r\n\r\n{parent_path}\r\n"
            ),
        )?;
    }
    push_multipart_text(&mut segments, &mut length, format!("--{boundary}--\r\n"))?;
    Ok((
        MultipartUploadBody {
            segments,
            current_segment: 0,
        },
        length,
    ))
}

fn agent_execution_error(error: String) -> String {
    if error.contains("Base URL") {
        "所选 Agent 无法连接其配置的大模型服务，请在 RAGFlow 中检查该 Agent 的模型 Base URL、密钥和代理设置。"
            .to_owned()
    } else {
        redact_trace_text(&error)
    }
}

fn parse_envelope(body: &str) -> Result<Envelope, String> {
    let envelope = serde_json::from_str::<Envelope>(body)
        .map_err(|_| "RAGFlow 返回的数据无法识别。".to_owned())?;
    if envelope.code != 0 {
        return Err(format!("RAGFlow：{}", redact_trace_text(&envelope.message)));
    }
    Ok(envelope)
}

#[cfg(test)]
mod transport_tests {
    use std::io::Read;

    use super::{build_upload_body, build_upload_bytes};

    #[test]
    fn ragflow_transport_never_starts_a_shell_process() {
        let source = include_str!("client.rs").to_ascii_lowercase();
        assert!(!source.contains(&["power", "shell.exe"].concat()));
        assert!(!source.contains(&["command", "::new"].concat()));
    }

    #[test]
    fn multipart_upload_body_streams_the_file_between_its_form_fields() {
        let path = std::env::temp_dir().join(format!(
            "qizhi-upload-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        std::fs::write(&path, b"file body").expect("write fixture");

        let (mut body, length) =
            build_upload_body("boundary", "fixture.txt", &path, Some("项目/资料"))
                .expect("build streaming multipart body");
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes).expect("read body");
        let text = String::from_utf8(bytes).expect("utf8 fixture body");

        assert_eq!(length as usize, text.len());
        assert!(text.contains("filename=\"fixture.txt\""));
        assert!(text.contains("file body"));
        assert!(text.contains("name=\"parent_path\""));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn markdown_upload_body_uses_in_memory_bytes() {
        let (mut body, length) =
            build_upload_bytes("boundary", "今日总结.md", b"# summary", Some("工作总结"))
                .expect("build in-memory multipart body");
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes).expect("read body");
        let text = String::from_utf8(bytes).expect("utf8 body");

        assert_eq!(length as usize, text.len());
        assert!(text.contains("filename=\"今日总结.md\""));
        assert!(text.contains("Content-Type: text/markdown; charset=utf-8"));
        assert!(text.contains("# summary"));
        assert!(text.contains("工作总结"));
    }
}
