export type RagflowAgentConfig = {
  baseUrl: string;
  apiKey: string;
  datasetIds: string[];
};

export function readRagflowAgentConfig(source: NodeJS.ProcessEnv = process.env): RagflowAgentConfig {
  const baseUrl = source.RAGFLOW_BASE_URL?.trim() ?? '';
  const apiKey = source.RAGFLOW_API_KEY?.trim() ?? '';
  const datasetIds = (source.RAGFLOW_DATASET_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return { baseUrl, apiKey, datasetIds };
}

/** Configuration-only check. It intentionally performs no enterprise retrieval. */
export async function performSelfCheck(config: RagflowAgentConfig): Promise<{ ok: true }> {
  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error('RAGFLOW_BASE_URL must be an absolute URL.');
  }
  if (!config.apiKey) throw new Error('RAGFLOW_API_KEY must be configured.');
  return { ok: true };
}

async function main(): Promise<void> {
  await performSelfCheck(readRagflowAgentConfig());
}

if (process.argv[1]?.endsWith('self-check.ts')) void main();
