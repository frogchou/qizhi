export interface ControlPlaneEnv {
  readonly port: number;
  readonly databaseUrl: string;
  readonly adminTokenHash: string;
  readonly nodeManagerUrl: string;
  readonly nodeManagerInternalToken: string;
  readonly ragflowBaseUrl: string;
  readonly ragflowDatasetIds: readonly string[];
  readonly codexPlannerTimeoutMs?: number;
  readonly agentPackageRoot?: string;
  readonly taskInputMaxFileBytes?: number;
  readonly taskInputMaxCount?: number;
  readonly taskInputMaxTotalBytes?: number;
}

type EnvironmentSource = Record<string, string | undefined>;

export function loadControlPlaneEnv(source: EnvironmentSource): ControlPlaneEnv {
  const databaseUrl = requiredUrl(source, 'DATABASE_URL');
  const adminTokenHash = required(source, 'MG_ADMIN_TOKEN_HASH');
  const nodeManagerUrl = requiredUrl(source, 'MG_NODE_MANAGER_URL');
  const nodeManagerInternalToken = required(source, 'MG_NODE_INTERNAL_TOKEN');
  const ragflowBaseUrl = requiredUrl(source, 'RAGFLOW_BASE_URL');

  required(source, 'RAGFLOW_API_KEY');

  if (!/^[a-f0-9]{64}$/i.test(adminTokenHash)) {
    throw new Error('MG_ADMIN_TOKEN_HASH must be a SHA-256 hexadecimal hash');
  }

  return Object.freeze({
    port: optionalPort(source.MG_PORT),
    databaseUrl,
    adminTokenHash,
    nodeManagerUrl,
    nodeManagerInternalToken,
    ragflowBaseUrl,
    ragflowDatasetIds: parseDatasetIds(source.RAGFLOW_DATASET_IDS),
    codexPlannerTimeoutMs: optionalPositiveMilliseconds(source.MG_CODEX_PLANNER_TIMEOUT_MS),
    agentPackageRoot: source.MG_AGENT_PACKAGE_ROOT?.trim() || undefined,
    taskInputMaxFileBytes: optionalBoundedInteger(source.MG_TASK_INPUT_MAX_FILE_BYTES, 'MG_TASK_INPUT_MAX_FILE_BYTES', 1, 1_073_741_824),
    taskInputMaxCount: optionalBoundedInteger(source.MG_TASK_INPUT_MAX_COUNT, 'MG_TASK_INPUT_MAX_COUNT', 1, 100),
    taskInputMaxTotalBytes: optionalBoundedInteger(source.MG_TASK_INPUT_MAX_TOTAL_BYTES, 'MG_TASK_INPUT_MAX_TOTAL_BYTES', 1, 5_368_709_120),
  });
}

function optionalBoundedInteger(value: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function optionalPositiveMilliseconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 1_800_000) {
    throw new Error('MG_CODEX_PLANNER_TIMEOUT_MS must be an integer between 1000 and 1800000');
  }
  return milliseconds;
}

function required(source: EnvironmentSource, key: string): string {
  const value = source[key]?.trim();

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function requiredUrl(source: EnvironmentSource, key: string): string {
  const value = required(source, key);

  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
}

function optionalPort(value: string | undefined): number {
  if (!value) {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MG_PORT must be an integer between 1 and 65535');
  }

  return port;
}

function parseDatasetIds(value: string | undefined): readonly string[] {
  return value?.split(',').map((datasetId) => datasetId.trim()).filter(Boolean) ?? [];
}
