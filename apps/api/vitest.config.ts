import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.e2e-spec.ts'],
          exclude: ['test/phase3/**'],
          globalSetup: ['test/phase3/support/legacy-database-global-setup.ts'],
          setupFiles: ['test/phase3/support/legacy-database-setup.ts'],
        },
      },
    ],
    pool: 'forks',
    isolate: true,
    maxConcurrency: 1,
    hookTimeout: 60000,
    sequence: { hooks: 'stack' },
  },
});
