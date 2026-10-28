use std::time::Duration;

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
        let response = request
            .send()
            .map_err(|_| "无法连接 Base URL，请检查网络、地址和代理设置。".to_owned())?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|_| "无法读取服务返回的数据。".to_owned())?;
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
            .map_err(|_| "无法连接 Base URL，请检查网络、地址和代理设置。".to_owned())?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .map_err(|_| "无法读取服务返回的文件。".to_owned())?
            .to_vec();
        Ok(HttpBytesResponse { status, body })
    }
}
