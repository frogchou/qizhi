use crate::database::AppError;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub trait SecretStore: Clone + Send + Sync + 'static {
    fn put(&self, reference: &str, secret: &str) -> Result<(), AppError>;
    fn get(&self, reference: &str) -> Result<String, AppError>;
    fn delete(&self, reference: &str) -> Result<(), AppError>;
    fn exists(&self, reference: &str) -> Result<bool, AppError>;
}

#[derive(Clone, Default)]
pub struct SystemCredentialStore;

impl SystemCredentialStore {
    fn entry(reference: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new("qizhi", reference).map_err(credential_error)
    }
}

impl SecretStore for SystemCredentialStore {
    fn put(&self, reference: &str, secret: &str) -> Result<(), AppError> {
        Self::entry(reference)?
            .set_password(secret)
            .map_err(credential_error)
    }
    fn get(&self, reference: &str) -> Result<String, AppError> {
        Self::entry(reference)?
            .get_password()
            .map_err(credential_error)
    }
    fn delete(&self, reference: &str) -> Result<(), AppError> {
        Self::entry(reference)?
            .delete_credential()
            .map_err(credential_error)
    }
    fn exists(&self, reference: &str) -> Result<bool, AppError> {
        #[cfg(target_os = "macos")]
        return match Self::entry(reference)?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(credential_error(error)),
        };
        #[cfg(not(target_os = "macos"))]
        Ok(Self::entry(reference)?.get_password().is_ok())
    }
}

fn credential_error(error: keyring::Error) -> AppError {
    #[cfg(target_os = "macos")]
    if matches!(
        error,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    ) {
        return AppError::KeychainUnavailable;
    }
    let _ = error;
    AppError::Storage
}

pub(crate) fn credential_message(error: AppError, fallback: &str) -> String {
    #[cfg(target_os = "macos")]
    if matches!(error, AppError::KeychainUnavailable) {
        return "无法访问登录钥匙串，请解锁或允许栖知访问后重试。".to_owned();
    }
    let _ = error;
    fallback.to_owned()
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
    fn get(&self, reference: &str) -> Result<String, AppError> {
        self.0
            .lock()
            .map_err(|_| AppError::Storage)?
            .get(reference)
            .cloned()
            .ok_or(AppError::Storage)
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
