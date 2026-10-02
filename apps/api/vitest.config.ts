import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    exclude: ['test/phase3/**'],
    globalSetup: ['test/phase3/support/legacy-database-global-setup.ts'],
    setupFiles: ['test/phase3/support/legacy-database-setup.ts'],
    pool: 'forks',
    isolate: true,
    maxConcurrency: 1,
    hookTimeout: 60000,
    sequence: { hooks: 'stack' },
  },
});
