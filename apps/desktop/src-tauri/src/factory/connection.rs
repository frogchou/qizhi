use crate::{config::SecretStore, database::Database};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use url::Url;
use uuid::Uuid;

const STORAGE: &str = "无法读取或保存工厂连接，请检查本机凭据管理器。";
const TOKEN: &str = "请为此控制面地址输入管理员令牌。";
const ADDRESS: &str = "请输入 HTTP 或 HTTPS 控制面地址。";

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Demo,
    Live,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Demo => "demo",
            Self::Live => "live",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionInput {
    pub mode: Mode,
    pub endpoint: String,
    #[serde(default)]
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub mode: Mode,
    pub endpoint: String,
    pub has_token: bool,
}

#[derive(Default)]
struct Stored {
    mode: Mode,
    endpoint: String,
    reference: Option<String>,
}

pub(super) struct Auth {
    pub endpoint: String,
    pub token: String,
}

pub(super) struct ConnectionStore<S> {
    database: Database,
    secrets: S,
    // Each snapshot uses a matching address and credential, even during rotation.
    lock: Mutex<()>,
}

impl<S: SecretStore> ConnectionStore<S> {
    pub fn new(database: Database, secrets: S) -> Self {
        Self {
            database,
            secrets,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Stored, String> {
        self.database.with_connection(|db| {
            db.query_row("SELECT mode, endpoint, credential_reference FROM factory_connection WHERE id=1", [], |row| {
                let mode = match row.get::<_, String>(0)?.as_str() {
                    "demo" => Mode::Demo,
                    "live" => Mode::Live,
                    _ => return Err(rusqlite::Error::InvalidQuery),
                };
                Ok(Stored { mode, endpoint: row.get(1)?, reference: row.get(2)? })
            }).optional()
        }).map(Option::unwrap_or_default).map_err(|_| STORAGE.to_owned())
    }

    pub fn settings(&self) -> Result<Settings, String> {
        let _guard = self.lock.lock().map_err(|_| STORAGE)?;
        let current = self.read()?;
        let has_token = match current.reference {
            Some(reference) => self.secrets.exists(&reference).map_err(|_| STORAGE)?,
            None => false,
        };
        Ok(Settings {
            mode: current.mode,
            endpoint: current.endpoint,
            has_token,
        })
    }

    pub fn save(&self, input: ConnectionInput) -> Result<Settings, String> {
        let _guard = self.lock.lock().map_err(|_| STORAGE)?;
        let old = self.read()?;
        let endpoint = if input.endpoint.trim().is_empty() && input.mode == Mode::Demo {
            String::new()
        } else {
            normalize_endpoint(&input.endpoint)?
        };
        let token = input.token.trim();
        let saved_key = if old.endpoint == endpoint {
            old.reference.as_deref()
        } else {
            None
        };
        let mut new_key = None;
        let reference = if !token.is_empty() {
            if endpoint.is_empty() {
                return Err(ADDRESS.to_owned());
            }
            validate_token(token)?;
            let key = format!("qizhi/factory/{}", Uuid::new_v4());
            self.secrets.put(&key, token).map_err(|_| STORAGE)?;
            new_key = Some(key);
            new_key.as_deref()
        } else {
            saved_key
        };
        let has_token = if let Some(key) = &new_key {
            // Read back a new credential before switching the database reference.
            if !self.secrets.get(key).is_ok_and(|stored| stored == token) {
                let _ = self.secrets.delete(key);
                return Err(STORAGE.to_owned());
            }
            true
        } else if let Some(key) = reference {
            self.secrets.exists(key).map_err(|_| STORAGE)?
        } else {
            false
        };
        if input.mode == Mode::Live && !has_token {
            return Err(TOKEN.to_owned());
        }

        let write = self.database.with_connection(|db| {
            db.execute("INSERT INTO factory_connection(id, mode, endpoint, credential_reference) VALUES (1, ?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode, endpoint=excluded.endpoint, credential_reference=excluded.credential_reference", (input.mode.as_str(), &endpoint, reference))?;
            Ok(())
        });
        if write.is_err() {
            if let Some(key) = new_key {
                let _ = self.secrets.delete(&key);
            }
            return Err(STORAGE.to_owned());
        }
        if let Some(old_key) = old
            .reference
            .as_deref()
            .filter(|key| Some(*key) != reference)
        {
            let _ = self.secrets.delete(old_key);
        }
        Ok(Settings {
            mode: input.mode,
            endpoint,
            has_token,
        })
    }

    fn existing_token(&self, current: &Stored, endpoint: &str) -> Result<String, String> {
        if current.endpoint != endpoint {
            return Err(TOKEN.to_owned());
        }
        let reference = current.reference.as_deref().ok_or(TOKEN)?;
        self.secrets.get(reference).map_err(|_| TOKEN.to_owned())
    }

    pub fn for_test(&self, input: ConnectionInput) -> Result<Auth, String> {
        let _guard = self.lock.lock().map_err(|_| STORAGE)?;
        let endpoint = normalize_endpoint(&input.endpoint)?;
        let token = if input.token.trim().is_empty() {
            self.existing_token(&self.read()?, &endpoint)?
        } else {
            input.token.trim().to_owned()
        };
        validate_token(&token)?;
        Ok(Auth { endpoint, token })
    }

    pub fn for_live(&self) -> Result<Auth, String> {
        let _guard = self.lock.lock().map_err(|_| STORAGE)?;
        let current = self.read()?;
        if current.mode != Mode::Live {
            return Err("请在设置中选择实时工厂。".to_owned());
        }
        let endpoint = normalize_endpoint(&current.endpoint)?;
        let token = self.existing_token(&current, &endpoint)?;
        validate_token(&token)?;
        Ok(Auth { endpoint, token })
    }
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(TOKEN.to_owned());
    }
    Ok(())
}

pub(super) fn normalize_endpoint(value: &str) -> Result<String, String> {
    let input = value.trim();
    let url = Url::parse(input).map_err(|_| ADDRESS)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || input.contains(['@', '\\'])
        || input.chars().any(char::is_control)
    {
        return Err(ADDRESS.to_owned());
    }
    if url.host().is_none() || !matches!(url.scheme(), "http" | "https") {
        return Err(ADDRESS.to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FakeSecretStore;

    fn input(mode: Mode, endpoint: &str, token: &str) -> ConnectionInput {
        ConnectionInput {
            mode,
            endpoint: endpoint.to_owned(),
            token: token.to_owned(),
        }
    }

    #[test]
    fn addresses_accept_public_http_without_carrying_secrets() {
        assert_eq!(
            normalize_endpoint("http://192.168.2.219:3010/").unwrap(),
            "http://192.168.2.219:3010"
        );
        assert_eq!(
            normalize_endpoint("http://121.28.95.155:3010/").unwrap(),
            "http://121.28.95.155:3010"
        );
        assert!(normalize_endpoint("https://control.example.org").is_ok());
        assert!(normalize_endpoint("http://control.example.org").is_ok());
        assert!(normalize_endpoint("http://[::1]:3010").is_ok());
        for value in [
            "https://user@host",
            "https://host/?admin=x",
            "file:///c:/tmp",
            "http://127.0.0.1/console",
            "https://host/#token",
        ] {
            assert!(normalize_endpoint(value).is_err(), "{value}");
        }
    }

    #[test]
    fn legacy_mode_is_demo_and_tests_and_address_changes_cannot_reuse_another_origins_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.sqlite");
        let db = Database::open(&path).unwrap();
        let store = ConnectionStore::new(db.clone(), FakeSecretStore::default());
        let first = "http://127.0.0.1:3010";
        let second = "http://127.0.0.1:3011";
        assert!(store.settings().unwrap().mode == Mode::Demo);
        assert!(store.for_live().is_err());
        assert!(
            store
                .save(input(Mode::Live, first, "fixture-only"))
                .unwrap()
                .has_token
        );
        assert!(store.for_test(input(Mode::Live, second, "")).is_err());
        assert!(store.save(input(Mode::Live, second, "")).is_err());
        assert_eq!(
            store
                .for_test(input(Mode::Live, second, "temporary"))
                .unwrap()
                .endpoint,
            second
        );
        assert_eq!(store.for_live().unwrap().token, "fixture-only");
        assert!(store.save(input(Mode::Demo, first, "")).unwrap().has_token);
        drop(store);
        drop(db);
        let reopened = Database::open(&path).unwrap();
        let (mode, endpoint, reference) = reopened
            .with_connection(|db| {
                db.query_row(
                    "SELECT mode,endpoint,credential_reference FROM factory_connection",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
            })
            .unwrap();
        assert_eq!((mode.as_str(), endpoint.as_str()), ("demo", first));
        assert!(reference.starts_with("qizhi/factory/"));
        assert!(!reference.contains("fixture-only"));
    }
}
