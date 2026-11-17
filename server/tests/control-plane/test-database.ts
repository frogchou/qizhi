/**
 * E2E specifications call dropDatabase(), so a test URL is mandatory and may
 * never point at the service database named `middleground`.
 */
export function requiredTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL must be set to an isolated test database before running database tests.');
  const parsed = new URL(value);
  if (parsed.pathname === '/middleground') throw new Error('TEST_DATABASE_URL must not reference the production middleground database.');
  return value;
}
