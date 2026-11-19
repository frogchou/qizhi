CREATE TABLE IF NOT EXISTS model_provider_settings (
  provider_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_reference TEXT NOT NULL,
  api_key_mask TEXT NOT NULL,
  supports_responses INTEGER NOT NULL DEFAULT 0 CHECK (supports_responses IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  updated_at_utc_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_model_provider
ON model_provider_settings(is_active)
WHERE is_active = 1;

INSERT OR IGNORE INTO model_provider_settings(
  provider_id,
  display_name,
  endpoint,
  model,
  credential_reference,
  api_key_mask,
  supports_responses,
  is_active,
  updated_at_utc_ms
)
SELECT
  'openai',
  'OpenAI / OpenAI 兼容',
  CASE
    WHEN instr(substr(rtrim(endpoint, '/'), instr(rtrim(endpoint, '/'), '://') + 3), '/') = 0
      THEN rtrim(endpoint, '/') || '/v1'
    ELSE rtrim(endpoint, '/')
  END,
  (SELECT model FROM openai_summary_settings WHERE id = 1),
  credential_reference,
  api_key_mask,
  1,
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM app_config
WHERE service = 'openai';
