export type RagflowAgentConfig = {
  baseUrl: string;
  apiKey: string;
  datasetIds: string[];
};

export function readRagflowAgentConfig(source: NodeJS.ProcessEnv = process.env): RagflowAgentConfig {
  const baseUrl = source.RAGFLOW_BASE_URL?.trim() ?? '';
  const apiKey = source.RAGFLOW_API_KEY?.trim() ?? '';
  const datasetIds = (source.RAGFLOW_DATASET_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const config = { baseUrl, apiKey, datasetIds };
  validateRuntimeConfig(config);
  return config;
}

/** Validates the runtime-only configuration injected for a leased execution. */
export async function performSelfCheck(config: RagflowAgentConfig): Promise<{ ok: true }> {
  validateRuntimeConfig(config);
  return { ok: true };
}

/** Safe during approval: node management never receives enterprise credentials. */
export async function performPackageSelfCheck(): Promise<{ ok: true }> {
  return { ok: true };
}

function validateRuntimeConfig(config: RagflowAgentConfig): void {
  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error('RAGFLOW_BASE_URL must be an absolute URL.');
  }
  if (!config.apiKey) throw new Error('RAGFLOW_API_KEY must be configured.');
}

async function main(): Promise<void> {
  await performPackageSelfCheck();
}

if (process.argv[1]?.endsWith('self-check.ts')) void main();
