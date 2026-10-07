import { defineConfig, devices } from '@playwright/test';

const apiEnvironment = JSON.parse(process.env.BARTER_E2E_API_ENV ?? '{}') as Record<string, string>;
if (!apiEnvironment.DATABASE_URL) throw new Error('Run acceptance through npm run e2e to allocate an isolated database.');
const frontendEnvironment = { ...process.env, BARTER_E2E_API_ENV: '', E2E_REVIEWER_PASSWORD: '' };

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      cwd: '..',
      command: 'node apps/api/dist/src/main.js',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...apiEnvironment,
        BARTER_E2E_API_ENV: '',
        NODE_ENV: 'test',
        PORT: '3000',
        WECHAT_IDENTITY_PROVIDER: 'acceptance',
        CORS_ORIGINS: 'http://127.0.0.1:10086,http://localhost:10086',
        IMAGE_PUBLIC_BASE_URL:
          'http://127.0.0.1:3000/api/uploads/item-images/files',
      },
    },
    {
      cwd: '..',
      command: 'node scripts/serve-static.mjs apps/miniapp/dist 10086',
      env: frontendEnvironment,
      url: 'http://127.0.0.1:10086/pages/items/create/index',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      cwd: '..',
      command:
        'npm run dev --workspace @barter/admin -- --host 127.0.0.1 --strictPort',
      env: frontendEnvironment,
      url: 'http://127.0.0.1:5173/login',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
