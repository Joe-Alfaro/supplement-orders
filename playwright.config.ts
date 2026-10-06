import { defineConfig } from '@playwright/test'

// One shared supplement_orders_e2e database, created, migrated and reset to the small seed by
// the API server's own command before it starts, so the health check below only
// passes once the database exists (Codex audit L2: Playwright starts webServer
// before globalSetup). Specs must not run in parallel or they would see each
// other's orders, stock, and dashboard totals.
const retries = process.env.CI ? 2 : 0

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries,
  timeout: 90_000,
  expect: { timeout: 10_000 },
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
      command: 'npm run e2e:db && npm run e2e:api',
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
