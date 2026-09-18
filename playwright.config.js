import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BSW_BASE_URL || 'http://127.0.0.1:3111',
    headless: true,
    ignoreHTTPSErrors: false,
    trace: 'off',
    video: 'off',
  },
});
