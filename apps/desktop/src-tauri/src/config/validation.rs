use crate::database::AppError;

pub fn validate_endpoint(endpoint: &str) -> Result<(), AppError> {
    let url = url::Url::parse(endpoint).map_err(|_| AppError::InvalidConfig)?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(()),
        _ => Err(AppError::InvalidConfig),
    }
}
