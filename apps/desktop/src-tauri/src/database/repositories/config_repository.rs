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
}
