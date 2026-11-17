import { afterEach, describe, expect, it, vi } from 'vitest';

import { requiredTestDatabaseUrl } from './test-database';

describe('test database guard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires an explicit isolated test database URL', () => {
    vi.stubEnv('TEST_DATABASE_URL', '');
    expect(requiredTestDatabaseUrl).toThrow(/must be set/i);
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://test:test@127.0.0.1:5433/middleground');
    expect(requiredTestDatabaseUrl).toThrow(/production/i);
    vi.stubEnv('TEST_DATABASE_URL', 'postgres://test:test@127.0.0.1:5433/middleground_test');
    expect(requiredTestDatabaseUrl()).toContain('middleground_test');
  });
});
