import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/phase4/**/*.e2e-spec.ts'],
    globalSetup: ['test/phase4/support/database-global-setup.ts'],
    pool: 'forks', isolate: true, maxConcurrency: 1,
    // Keep owned PostgreSQL clone/cleanup contention within existing timeouts.
    maxWorkers: 2,
    testTimeout: 30000, hookTimeout: 60000,
  },
});
