use crate::{
    contracts::ModelProviderConfig,
    database::{AppError, Database},
};
use rusqlite::OptionalExtension;

#[derive(Clone)]
pub struct ModelProviderRepository {
    database: Database,
}

impl ModelProviderRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn list(&self) -> Result<Vec<ModelProviderConfig>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT provider_id,display_name,endpoint,model,credential_reference,api_key_mask,supports_responses,is_active,updated_at_utc_ms FROM model_provider_settings ORDER BY provider_id",
            )?;
            statement
                .query_map([], provider_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub fn find(&self, provider_id: &str) -> Result<Option<ModelProviderConfig>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT provider_id,display_name,endpoint,model,credential_reference,api_key_mask,supports_responses,is_active,updated_at_utc_ms FROM model_provider_settings WHERE provider_id=?1",
                    [provider_id],
                    provider_from_row,
                )
                .optional()
        })
    }

    pub fn active(&self) -> Result<Option<ModelProviderConfig>, AppError> {
        self.database.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT provider_id,display_name,endpoint,model,credential_reference,api_key_mask,supports_responses,is_active,updated_at_utc_ms FROM model_provider_settings WHERE is_active=1",
                    [],
                    provider_from_row,
                )
                .optional()
        })
    }

    pub fn save(&self, config: &ModelProviderConfig) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO model_provider_settings(provider_id,display_name,endpoint,model,credential_reference,api_key_mask,supports_responses,is_active,updated_at_utc_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(provider_id) DO UPDATE SET display_name=excluded.display_name,endpoint=excluded.endpoint,model=excluded.model,credential_reference=excluded.credential_reference,api_key_mask=excluded.api_key_mask,supports_responses=excluded.supports_responses,updated_at_utc_ms=excluded.updated_at_utc_ms",
                (
                    &config.provider_id,
                    &config.display_name,
                    &config.endpoint,
                    &config.model,
                    &config.credential_reference,
                    &config.api_key_mask,
                    config.supports_responses,
                    config.is_active,
                    config.updated_at_utc_ms,
                ),
            )?;
            Ok(())
        })
    }

    pub fn activate(&self, provider_id: &str) -> Result<(), AppError> {
        self.database.with_transaction(|transaction| {
            let exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM model_provider_settings WHERE provider_id=?1)",
                [provider_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            transaction.execute(
                "UPDATE model_provider_settings SET is_active=0 WHERE is_active=1",
                [],
            )?;
            transaction.execute(
                "UPDATE model_provider_settings SET is_active=1 WHERE provider_id=?1",
                [provider_id],
            )?;
            Ok(())
        })
    }

    pub fn migrate_legacy_openai(&self) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            connection
                .execute_batch(include_str!("../../../migrations/0015_model_providers.sql"))?;
            Ok(())
        })
    }
}

fn provider_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelProviderConfig> {
    Ok(ModelProviderConfig {
        provider_id: row.get(0)?,
        display_name: row.get(1)?,
        endpoint: row.get(2)?,
        model: row.get(3)?,
        credential_reference: row.get(4)?,
        api_key_mask: row.get(5)?,
        supports_responses: row.get(6)?,
        is_active: row.get(7)?,
        updated_at_utc_ms: row.get(8)?,
    })
}
