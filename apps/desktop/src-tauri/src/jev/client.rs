use std::{collections::HashMap, time::Duration};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    config::{SecretStore, secret_store::WindowsCredentialStore},
    contracts::JevValuePolicy,
    database::repositories::ConfigRepository,
    network::http::HttpClient,
};

#[derive(Clone, Debug)]
pub struct ValueDocument {
    pub key: String,
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ValueJudgment {
    pub score: f64,
    pub confidence: f64,
}

impl ValueJudgment {
    pub fn is_valuable(&self) -> bool {
        self.score >= 2.5
    }

    pub fn is_valuable_at(&self, threshold: f64) -> bool {
        self.score >= threshold
    }
}

#[derive(Deserialize)]
struct SystemOneResponse {
    answers: HashMap<String, ScoreAnswer>,
}

#[derive(Deserialize)]
struct ScoreAnswer {
    #[serde(rename = "type")]
    answer_type: String,
    score: f64,
    confidence: f64,
}

#[derive(Serialize)]
struct ValueState<'a> {
    files: HashMap<&'a str, ValueStateFile<'a>>,
}

#[derive(Serialize)]
struct ValueStateFile<'a> {
    name: &'a str,
    content: &'a str,
}

#[derive(Clone)]
pub struct JevClient {
    base_url: Url,
    api_key: String,
}

impl JevClient {
    pub fn from_saved_config(
        configs: ConfigRepository,
        secrets: WindowsCredentialStore,
    ) -> Result<Self, String> {
        let config = configs
            .find("jev")
            .map_err(|_| "无法读取 JEV 设置。".to_owned())?
            .ok_or_else(|| "请先在设置中保存 JEV Base URL 和 API Key。".to_owned())?;
        let api_key = secrets
            .get(&config.credential_reference)
            .map_err(|_| "无法读取 JEV API Key，请在设置中重新保存。".to_owned())?;
        Self::new(&config.endpoint, api_key)
    }

    pub fn new(endpoint: &str, api_key: String) -> Result<Self, String> {
        if api_key.trim().is_empty() || api_key.contains(['\r', '\n']) {
            return Err("JEV API Key 无效。".to_owned());
        }
        let base_url =
            Url::parse(endpoint.trim()).map_err(|_| "JEV Base URL 格式不正确。".to_owned())?;
        if !matches!(base_url.scheme(), "http" | "https") {
            return Err("JEV Base URL 仅支持 HTTP 或 HTTPS。".to_owned());
        }
        Ok(Self { base_url, api_key })
    }

    pub fn assess_documents(
        &self,
        documents: &[ValueDocument],
        policy: &JevValuePolicy,
    ) -> Result<HashMap<String, ValueJudgment>, String> {
        if documents.is_empty() {
            return Ok(HashMap::new());
        }
        let files = documents
            .iter()
            .map(|document| {
                (
                    document.key.as_str(),
                    ValueStateFile {
                        name: &document.name,
                        content: &document.content,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let questions = documents
            .iter()
            .map(|document| {
                (
                    document.key.clone(),
                    serde_json::json!({
                        "type": "score",
                        "instructions": format!(
                            "{}\n评估对象为 `files.{}`，请同时考虑文件名和实际内容。",
                            policy.instructions.trim(), document.key
                        ),
                        "criteria": policy.criteria,
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let body = serde_json::to_string(&serde_json::json!({
            "model": "jev-latest",
            "state": ValueState { files },
            "questions": questions,
        }))
        .map_err(|_| "无法构造 JEV 价值评估请求。".to_owned())?;
        let url = self.system_one_url()?;
        let response = HttpClient::with_timeout(Duration::from_secs(30))?.request_bearer(
            reqwest::Method::POST,
            url.as_str(),
            &self.api_key,
            Some(body),
        )?;
        if response.status != 200 {
            return Err(jev_http_error_message(response.status));
        }
        Self::parse_value_response(&response.body)
    }

    pub fn parse_value_response(body: &str) -> Result<HashMap<String, ValueJudgment>, String> {
        let response = serde_json::from_str::<SystemOneResponse>(body)
            .map_err(|_| "JEV 返回的数据无法识别。".to_owned())?;
        response
            .answers
            .into_iter()
            .map(|(key, answer)| {
                if answer.answer_type != "score"
                    || !answer.score.is_finite()
                    || !answer.confidence.is_finite()
                {
                    return Err("JEV 返回了无效的价值评分。".to_owned());
                }
                Ok((
                    key,
                    ValueJudgment {
                        score: answer.score,
                        confidence: answer.confidence,
                    },
                ))
            })
            .collect()
    }

    fn system_one_url(&self) -> Result<Url, String> {
        let mut url = self.base_url.clone();
        let base = url.path().trim_end_matches('/');
        let path = if base.ends_with("/v1") {
            format!("{base}/systemone")
        } else {
            format!("{base}/v1/systemone")
        };
        url.set_path(&path);
        url.set_query(None);
        Ok(url)
    }
}

fn jev_http_error_message(status: u16) -> String {
    if status == 451 {
        return "JEV 价值评估请求被拒绝（HTTP 451）。请确认网络或代理允许访问 TypeSafe AI 的 /v1/systemone 接口。".to_owned();
    }
    format!("JEV 价值评估失败（HTTP {status}）。")
}

#[cfg(test)]
mod tests {
    use super::jev_http_error_message;

    #[test]
    fn explains_when_a_jev_scoring_request_is_blocked_upstream() {
        assert_eq!(
            jev_http_error_message(451),
            "JEV 价值评估请求被拒绝（HTTP 451）。请确认网络或代理允许访问 TypeSafe AI 的 /v1/systemone 接口。"
        );
    }
}
