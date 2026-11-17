import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/*.e2e-spec.ts'],
    fileParallelism: false,
  },
});
