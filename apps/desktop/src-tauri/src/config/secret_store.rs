use crate::database::AppError;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub trait SecretStore: Clone + Send + Sync + 'static {
    fn put(&self, reference: &str, secret: &str) -> Result<(), AppError>;
    fn delete(&self, reference: &str) -> Result<(), AppError>;
    fn exists(&self, reference: &str) -> Result<bool, AppError>;
}

#[derive(Clone, Default)]
pub struct WindowsCredentialStore;

impl WindowsCredentialStore {
    fn entry(reference: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new("qizhi", reference).map_err(|_| AppError::Storage)
    }
}

impl SecretStore for WindowsCredentialStore {
    fn put(&self, reference: &str, secret: &str) -> Result<(), AppError> {
        Self::entry(reference)?
            .set_password(secret)
            .map_err(|_| AppError::Storage)
    }
    fn delete(&self, reference: &str) -> Result<(), AppError> {
        Self::entry(reference)?
            .delete_credential()
            .map_err(|_| AppError::Storage)
    }
    fn exists(&self, reference: &str) -> Result<bool, AppError> {
        Ok(Self::entry(reference)?.get_password().is_ok())
    }
}

#[derive(Clone, Default)]
pub struct FakeSecretStore(Arc<Mutex<HashMap<String, String>>>);
impl FakeSecretStore {
    pub fn contains(&self, reference: &str) -> bool {
        self.exists(reference).unwrap_or(false)
    }
}
impl SecretStore for FakeSecretStore {
    fn put(&self, reference: &str, secret: &str) -> Result<(), AppError> {
        self.0
            .lock()
            .map_err(|_| AppError::Storage)?
            .insert(reference.to_owned(), secret.to_owned());
        Ok(())
    }
    fn delete(&self, reference: &str) -> Result<(), AppError> {
        self.0
            .lock()
            .map_err(|_| AppError::Storage)?
            .remove(reference);
        Ok(())
    }
    fn exists(&self, reference: &str) -> Result<bool, AppError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| AppError::Storage)?
            .contains_key(reference))
    }
}
