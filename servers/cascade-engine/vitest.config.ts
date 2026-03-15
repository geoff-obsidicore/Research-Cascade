import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 10000,
    pool: 'forks', // Isolate tests to avoid shared DB state leaking
  },
});
