import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

export const STORAGE_STATE = path.join(__dirname, 'playwright/.auth/user.json');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 90000,
  expect: { timeout: 20000 },
  globalSetup: require.resolve('./e2e/global.setup.ts'),
  globalTeardown: require.resolve('./e2e/global.teardown.ts'),
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3002',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Used for tests that do NOT want the global auth state (like Registration/Login flows)
      name: 'unauthenticated',
      testMatch: /auth\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Used for most tests that require being logged in
      name: 'chromium',
      testIgnore: /auth\.spec\.ts|mobile-layout\.spec\.ts/,
      use: { 
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
      },
    },
    {
      // The only project with a phone viewport. Everything else here is
      // Desktop Chrome, which is why the mobile gutter drifted unnoticed
      // across a dozen pages in the first place.
      name: 'mobile',
      testMatch: /mobile-layout\.spec\.ts/,
      use: {
        ...devices['Pixel 5'],
        storageState: STORAGE_STATE,
      },
    }
  ],
});
