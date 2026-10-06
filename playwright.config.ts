import { defineConfig } from '@playwright/test'

// One shared supplement_orders_e2e database, reset once in globalSetup. Specs must not run
// in parallel or they would see each other's orders, stock, and dashboard totals.
const retries = process.env.CI ? 2 : 0

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5174',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run e2e:api',
      url: 'http://localhost:3100/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run e2e:web',
      url: 'http://localhost:5174',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
