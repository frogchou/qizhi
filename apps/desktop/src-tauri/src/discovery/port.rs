use crate::{database::AppError, scan::policy::AllowedRoot};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredFile {
    pub path: String,
    pub size_bytes: i64,
    pub modified_at_utc_ms: i64,
}
#[derive(Clone, Debug)]
pub struct DiscoveryHealth {
    pub available: bool,
    pub adapter: String,
    pub remediation: String,
}
pub trait FileDiscovery {
    fn name(&self) -> &'static str;
    fn health(&self) -> DiscoveryHealth;
    fn find_modified_between(
        &self,
        roots: &[AllowedRoot],
        start_utc_ms: i64,
        end_utc_ms: i64,
    ) -> Result<Vec<DiscoveredFile>, AppError>;
}
pub fn parse_es_output(output: &str) -> Result<Vec<DiscoveredFile>, AppError> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut columns = line.split('\t');
            let path = columns.next().ok_or(AppError::DiscoveryInvalidData)?;
            let size = columns
                .next()
                .ok_or(AppError::DiscoveryInvalidData)?
                .parse()
                .map_err(|_| AppError::DiscoveryInvalidData)?;
            let modified = columns
                .next()
                .ok_or(AppError::DiscoveryInvalidData)?
                .parse()
                .map_err(|_| AppError::DiscoveryInvalidData)?;
            Ok(DiscoveredFile {
                path: path.to_owned(),
                size_bytes: size,
                modified_at_utc_ms: modified,
            })
        })
        .collect()
}
