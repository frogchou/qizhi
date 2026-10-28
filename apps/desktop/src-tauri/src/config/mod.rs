pub mod secret_store;
pub mod validation;

pub use secret_store::{FakeSecretStore, SecretStore};

use crate::{
    contracts::MaskedServiceConfig,
    database::{AppError, repositories::ConfigRepository},
};

#[derive(Clone)]
pub struct ServiceConfigurationInput {
    pub service: String,
    pub endpoint: String,
    pub api_key: String,
}

#[derive(Clone)]
pub struct ConfigService<S: SecretStore> {
    repository: ConfigRepository,
    secrets: S,
}

impl<S: SecretStore> ConfigService<S> {
    pub fn new(repository: ConfigRepository, secrets: S) -> Self {
        Self {
            repository,
            secrets,
        }
    }
    pub fn save_masked(
        &self,
        input: ServiceConfigurationInput,
    ) -> Result<MaskedServiceConfig, AppError> {
        validation::validate_endpoint(&input.endpoint)?;
        if input.service.trim().is_empty() || input.api_key.trim().is_empty() {
            return Err(AppError::InvalidConfig);
        }
        let credential_reference = format!("qizhi/{}/default", input.service);
        self.secrets.put(&credential_reference, &input.api_key)?;
        if self.secrets.get(&credential_reference)? != input.api_key {
            return Err(AppError::Storage);
        }
        let config = MaskedServiceConfig {
            service: input.service,
            endpoint: input.endpoint,
            api_key_mask: "••••••••".to_owned(),
            credential_reference,
        };
        self.repository.save(&config)?;
        Ok(config)
    }
}
