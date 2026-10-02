import { defineConfig, devices } from '@playwright/test';

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
      command: 'npm run dev --workspace @barter/api',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '3000',
        WECHAT_IDENTITY_PROVIDER: 'acceptance',
        CORS_ORIGINS: 'http://127.0.0.1:10086,http://localhost:10086',
        LOCAL_IMAGE_STORAGE_DIR: '.local/e2e-item-images',
        IMAGE_PUBLIC_BASE_URL:
          'http://127.0.0.1:3000/api/uploads/item-images/files',
      },
    },
    {
      cwd: '..',
      command: 'node scripts/serve-static.mjs apps/miniapp/dist 10086',
      url: 'http://127.0.0.1:10086/pages/items/create/index',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      cwd: '..',
      command:
        'npm run dev --workspace @barter/admin -- --host 127.0.0.1 --strictPort',
      url: 'http://127.0.0.1:5173/login',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
