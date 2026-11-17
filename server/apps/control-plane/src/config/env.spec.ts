import { describe, expect, it } from 'vitest';

import { loadControlPlaneEnv } from './env';

const validEnvironment = {
  DATABASE_URL: 'postgres://app:password@127.0.0.1:5432/middleground',
  MG_ADMIN_TOKEN_HASH: 'a'.repeat(64),
  MG_NODE_MANAGER_URL: 'http://127.0.0.1:3100',
  MG_NODE_INTERNAL_TOKEN: 'node-manager-internal-token',
  RAGFLOW_BASE_URL: 'http://ragflow.example.invalid:11180',
  RAGFLOW_API_KEY: 'only-present-in-process-memory',
};

describe('loadControlPlaneEnv', () => {
  it('loads required configuration without exposing the RAGFlow API key', () => {
    const environment = loadControlPlaneEnv(validEnvironment);

    expect(environment.port).toBe(3000);
    expect(environment.ragflowBaseUrl).toBe('http://ragflow.example.invalid:11180');
    expect(environment.codexPlannerTimeoutMs).toBeUndefined();
    expect('ragflowApiKey' in environment).toBe(false);
  });

  it('rejects a missing administrator token hash', () => {
    const { MG_ADMIN_TOKEN_HASH: _omitted, ...environment } = validEnvironment;

    expect(() => loadControlPlaneEnv(environment)).toThrow('MG_ADMIN_TOKEN_HASH');
  });

  it('rejects an invalid RAGFlow base URL', () => {
    expect(() => loadControlPlaneEnv({ ...validEnvironment, RAGFLOW_BASE_URL: 'not-a-url' })).toThrow(
      'RAGFLOW_BASE_URL',
    );
  });

  it('accepts a bounded Codex planner timeout only', () => {
    expect(loadControlPlaneEnv({ ...validEnvironment, MG_CODEX_PLANNER_TIMEOUT_MS: '300000' }).codexPlannerTimeoutMs).toBe(300_000);
    expect(() => loadControlPlaneEnv({ ...validEnvironment, MG_CODEX_PLANNER_TIMEOUT_MS: '99' })).toThrow('MG_CODEX_PLANNER_TIMEOUT_MS');
  });

  it('accepts bounded task-input limits only', () => {
    const environment = loadControlPlaneEnv({ ...validEnvironment, MG_TASK_INPUT_MAX_FILE_BYTES: '4096', MG_TASK_INPUT_MAX_COUNT: '8', MG_TASK_INPUT_MAX_TOTAL_BYTES: '16384' });
    expect(environment.taskInputMaxFileBytes).toBe(4096);
    expect(environment.taskInputMaxCount).toBe(8);
    expect(environment.taskInputMaxTotalBytes).toBe(16384);
    expect(() => loadControlPlaneEnv({ ...validEnvironment, MG_TASK_INPUT_MAX_COUNT: '101' })).toThrow('MG_TASK_INPUT_MAX_COUNT');
  });
});
