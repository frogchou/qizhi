pub mod migrations;
pub mod repositories;

use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::{Connection, Result as SqlResult};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid configuration")]
    InvalidConfig,
    #[error("storage operation failed")]
    Storage,
    #[error("file discovery is unavailable")]
    DiscoveryUnavailable,
    #[error("file discovery returned invalid data")]
    DiscoveryInvalidData,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid_config",
            Self::Storage => "storage_error",
            Self::DiscoveryUnavailable => "discovery_unavailable",
            Self::DiscoveryInvalidData => "discovery_invalid_data",
        }
    }
}

#[derive(Clone)]
pub struct Database(Arc<Mutex<Connection>>);

impl Database {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let connection = Connection::open(path).map_err(|_| AppError::Storage)?;
        migrations::apply(&connection).map_err(|_| AppError::Storage)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub fn schema_version(&self) -> Result<i64, AppError> {
        self.with_connection(|connection| {
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, Option<i64>>(0)
                })
                .map(|version| version.unwrap_or(0))
        })
    }

    pub fn files(&self) -> repositories::FileRepository {
        repositories::FileRepository::new(self.clone())
    }
    pub fn configs(&self) -> repositories::ConfigRepository {
        repositories::ConfigRepository::new(self.clone())
    }

    pub fn debug_values(&self) -> Result<String, AppError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT service, endpoint, credential_reference, api_key_mask FROM app_config",
            )?;
            let values = statement
                .query_map([], |row| {
                    Ok(format!(
                        "{}|{}|{}|{}",
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?
                    ))
                })?
                .collect::<SqlResult<Vec<_>>>()?;
            Ok(values.join("\n"))
        })
    }

    pub(crate) fn with_connection<T>(
        &self,
        action: impl FnOnce(&Connection) -> SqlResult<T>,
    ) -> Result<T, AppError> {
        let connection = self.0.lock().map_err(|_| AppError::Storage)?;
        action(&connection).map_err(|_| AppError::Storage)
    }
}
