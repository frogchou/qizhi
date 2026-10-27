use crate::{
    contracts::MaskedServiceConfig,
    database::{AppError, Database},
};

#[derive(Clone)]
pub struct ConfigRepository {
    database: Database,
}

impl ConfigRepository {
    pub(crate) fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn save(&self, config: &MaskedServiceConfig) -> Result<(), AppError> {
        self.database.with_connection(|connection| {
            connection.execute("INSERT INTO app_config(service,endpoint,credential_reference,api_key_mask) VALUES (?1,?2,?3,?4) ON CONFLICT(service) DO UPDATE SET endpoint=excluded.endpoint,credential_reference=excluded.credential_reference,api_key_mask=excluded.api_key_mask", (&config.service, &config.endpoint, &config.credential_reference, &config.api_key_mask))?;
            Ok(())
        })
    }

    pub fn list(&self) -> Result<Vec<MaskedServiceConfig>, AppError> {
        self.database.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT service, endpoint, api_key_mask, credential_reference FROM app_config ORDER BY service")?;
            statement.query_map([], |row| Ok(MaskedServiceConfig { service: row.get(0)?, endpoint: row.get(1)?, api_key_mask: row.get(2)?, credential_reference: row.get(3)? }))?.collect()
        })
    }
}
