import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    poolOptions: {
      forks: {
        singleFork: true, // Important: SQLite needs single process for tests
      }
    },
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
