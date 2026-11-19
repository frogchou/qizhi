use chrono::Utc;

use crate::{
    config::{SecretStore, validation::validate_endpoint},
    contracts::ModelProviderConfig,
    database::{AppError, repositories::ModelProviderRepository},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelProviderPreset {
    pub provider_id: &'static str,
    pub display_name: &'static str,
    pub default_endpoint: &'static str,
    pub default_model: &'static str,
    pub supports_responses: bool,
    pub requires_api_key: bool,
}

const MODEL_PROVIDER_PRESETS: [ModelProviderPreset; 8] = [
    ModelProviderPreset {
        provider_id: "openai",
        display_name: "OpenAI / OpenAI 兼容",
        default_endpoint: "https://api.openai.com/v1",
        default_model: "gpt-5.6-sol",
        supports_responses: true,
        requires_api_key: true,
    },
    ModelProviderPreset {
        provider_id: "deepseek",
        display_name: "DeepSeek",
        default_endpoint: "https://api.deepseek.com/v1",
        default_model: "deepseek-flash",
        supports_responses: true,
        requires_api_key: true,
    },
    ModelProviderPreset {
        provider_id: "qwen",
        display_name: "阿里云百炼 / 千问",
        default_endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen-plus",
        supports_responses: false,
        requires_api_key: true,
    },
    ModelProviderPreset {
        provider_id: "moonshot",
        display_name: "Moonshot / Kimi",
        default_endpoint: "https://api.moonshot.cn/v1",
        default_model: "kimi-k3.1-pro",
        supports_responses: true,
        requires_api_key: true,
    },
    ModelProviderPreset {
        provider_id: "zhipu",
        display_name: "智谱 GLM",
        default_endpoint: "https://open.bigmodel.cn/api/paas/v4",
        default_model: "glm-5.3",
        supports_responses: false,
        requires_api_key: true,
    },
    ModelProviderPreset {
        provider_id: "minimax",
        display_name: "MiniMax",
        default_endpoint: "https://api.minimax.chat/v1",
        default_model: "MiniMax-Text-01",
        supports_responses: false,
        requires_api_key: true,
    },
    ModelProviderPreset {
        provider_id: "ollama",
        display_name: "Ollama",
        default_endpoint: "http://localhost:11434/v1",
        default_model: "qwen3:8b",
        supports_responses: false,
        requires_api_key: false,
    },
    ModelProviderPreset {
        provider_id: "custom",
        display_name: "自定义 OpenAI 兼容服务",
        default_endpoint: "",
        default_model: "",
        supports_responses: false,
        requires_api_key: true,
    },
];

pub fn model_provider_presets() -> &'static [ModelProviderPreset] {
    &MODEL_PROVIDER_PRESETS
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelProviderSaveInput {
    pub provider_id: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    pub supports_responses: Option<bool>,
}

#[derive(Clone)]
pub struct ModelProviderService<S: SecretStore> {
    repository: ModelProviderRepository,
    secrets: S,
}

impl<S: SecretStore> ModelProviderService<S> {
    pub fn new(repository: ModelProviderRepository, secrets: S) -> Self {
        Self {
            repository,
            secrets,
        }
    }

    pub fn list(&self) -> Result<Vec<ModelProviderConfig>, AppError> {
        let saved = self.repository.list()?;
        Ok(model_provider_presets()
            .iter()
            .map(|preset| {
                saved
                    .iter()
                    .find(|item| item.provider_id == preset.provider_id)
                    .cloned()
                    .unwrap_or_else(|| ModelProviderConfig {
                        provider_id: preset.provider_id.to_owned(),
                        display_name: preset.display_name.to_owned(),
                        endpoint: preset.default_endpoint.to_owned(),
                        model: preset.default_model.to_owned(),
                        credential_reference: String::new(),
                        api_key_mask: String::new(),
                        supports_responses: preset.supports_responses,
                        is_active: false,
                        updated_at_utc_ms: 0,
                    })
            })
            .collect())
    }

    pub fn save(&self, input: ModelProviderSaveInput) -> Result<ModelProviderConfig, AppError> {
        let preset = preset(&input.provider_id)?;
        let endpoint = input.endpoint.trim().trim_end_matches('/').to_owned();
        let model = input.model.trim().to_owned();
        validate_endpoint(&endpoint)?;
        if endpoint.len() > 2_048 || model.is_empty() || model.chars().count() > 120 {
            return Err(AppError::InvalidConfig);
        }
        let existing = self.repository.find(preset.provider_id)?;
        let supplied_key = input.api_key.trim();
        let credential_reference = existing
            .as_ref()
            .map(|item| item.credential_reference.clone())
            .filter(|reference| !reference.is_empty())
            .unwrap_or_else(|| format!("qizhi/model-provider/{}", preset.provider_id));
        let (credential_reference, api_key_mask) = if supplied_key.is_empty() {
            if !preset.requires_api_key && existing.is_none() {
                (String::new(), String::new())
            } else if !credential_reference.is_empty()
                && self.secrets.exists(&credential_reference)?
            {
                (
                    credential_reference,
                    existing
                        .as_ref()
                        .map(|item| item.api_key_mask.clone())
                        .unwrap_or_else(|| "••••••••".to_owned()),
                )
            } else if preset.requires_api_key {
                return Err(AppError::InvalidConfig);
            } else {
                (String::new(), String::new())
            }
        } else {
            if supplied_key.contains(['\r', '\n']) {
                return Err(AppError::InvalidConfig);
            }
            self.secrets.put(&credential_reference, supplied_key)?;
            (credential_reference, "••••••••".to_owned())
        };
        let config = ModelProviderConfig {
            provider_id: preset.provider_id.to_owned(),
            display_name: preset.display_name.to_owned(),
            endpoint,
            model,
            credential_reference,
            api_key_mask,
            supports_responses: if preset.provider_id == "custom" {
                input.supports_responses.unwrap_or(false)
            } else {
                preset.supports_responses
            },
            is_active: existing.as_ref().is_some_and(|item| item.is_active),
            updated_at_utc_ms: Utc::now().timestamp_millis(),
        };
        self.repository.save(&config)?;
        Ok(config)
    }

    pub fn activate(&self, provider_id: &str) -> Result<ModelProviderConfig, AppError> {
        preset(provider_id)?;
        let config = self
            .repository
            .find(provider_id)?
            .ok_or(AppError::InvalidConfig)?;
        if config.model.trim().is_empty()
            || (preset(provider_id)?.requires_api_key
                && (config.credential_reference.is_empty()
                    || !self.secrets.exists(&config.credential_reference)?))
        {
            return Err(AppError::InvalidConfig);
        }
        self.repository.activate(provider_id)?;
        self.repository.active()?.ok_or(AppError::InvalidConfig)
    }

    pub fn active(&self) -> Result<Option<ModelProviderConfig>, AppError> {
        self.repository.active()
    }

    pub fn resolve_api_key(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<Option<String>, AppError> {
        if config.credential_reference.is_empty() {
            return Ok(None);
        }
        self.secrets.get(&config.credential_reference).map(Some)
    }
}

fn preset(provider_id: &str) -> Result<&'static ModelProviderPreset, AppError> {
    model_provider_presets()
        .iter()
        .find(|item| item.provider_id == provider_id.trim())
        .ok_or(AppError::InvalidConfig)
}
