use std::{
    io::{BufRead, BufReader, Read},
    time::Duration,
};

const MAX_STREAM_FALLBACK_BYTES: usize = 4 * 1024 * 1024;

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub struct HttpBytesResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub struct HttpClient {
    client: reqwest::blocking::Client,
}

impl HttpClient {
    pub fn with_timeout(timeout: Duration) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|_| "无法初始化网络连接。".to_owned())?;
        Ok(Self { client })
    }

    pub fn request_bearer(
        &self,
        method: reqwest::Method,
        url: &str,
        api_key: &str,
        body: Option<String>,
    ) -> Result<HttpResponse, String> {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let response = request.send().map_err(transport_error)?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|_| "无法读取服务返回的数据。".to_owned())?;
        Ok(HttpResponse { status, body })
    }

    pub fn request_bearer_lines<F>(
        &self,
        method: reqwest::Method,
        url: &str,
        api_key: &str,
        body: Option<String>,
        mut on_line: F,
    ) -> Result<HttpResponse, String>
    where
        F: FnMut(&str) -> Result<(), String>,
    {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(api_key)
            .header(
                reqwest::header::ACCEPT,
                "text/event-stream, application/json",
            );
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        let response = request.send().map_err(transport_error)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response
                .text()
                .map_err(|_| "无法读取服务返回的数据。".to_owned())?;
            return Ok(HttpResponse { status, body });
        }

        let mut reader = BufReader::new(response);
        let mut body = String::new();
        let mut line = String::new();
        let mut is_stream = false;
        loop {
            line.clear();
            let bytes = reader
                .read_line(&mut line)
                .map_err(|_| "无法读取服务返回的数据。".to_owned())?;
            if bytes == 0 {
                break;
            }
            let normalized = line.trim_end_matches(['\r', '\n']);
            if !is_stream
                && (normalized.starts_with("data:")
                    || normalized.starts_with("event:")
                    || normalized.starts_with(':'))
            {
                is_stream = true;
                body.clear();
            }
            if !is_stream {
                if body.len().saturating_add(line.len()) > MAX_STREAM_FALLBACK_BYTES {
                    return Err("服务返回的数据过大，已停止读取。".to_owned());
                }
                body.push_str(&line);
            }
            on_line(normalized)?;
        }
        Ok(HttpResponse { status, body })
    }

    pub fn request_bearer_bytes(
        &self,
        method: reqwest::Method,
        url: &str,
        api_key: &str,
    ) -> Result<HttpBytesResponse, String> {
        let response = self
            .client
            .request(method, url)
            .bearer_auth(api_key)
            .send()
            .map_err(transport_error)?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .map_err(|_| "无法读取服务返回的文件。".to_owned())?
            .to_vec();
        Ok(HttpBytesResponse { status, body })
    }

    pub fn request_bearer_multipart<R: Read + Send + 'static>(
        &self,
        url: &str,
        api_key: &str,
        boundary: &str,
        body: R,
        content_length: u64,
    ) -> Result<HttpResponse, String> {
        let response = self
            .client
            .post(url)
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(reqwest::blocking::Body::sized(body, content_length))
            .send()
            .map_err(transport_error)?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|_| "无法读取服务返回的数据。".to_owned())?;
        Ok(HttpResponse { status, body })
    }
}

fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "RAGFlow 请求超时，请稍后重试。".to_owned()
    } else {
        "无法连接 Base URL，请检查网络、地址和代理设置。".to_owned()
    }
}
