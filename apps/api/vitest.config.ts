import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // Test files in one run share this checkout's Postgres test database and
    // truncate it between tests, so they must not run concurrently. Separate
    // checkouts get separate databases (see testDatabaseName).
    fileParallelism: false,
    // The shared CI runner is CPU-starved; give slow tests headroom there only.
    ...(process.env.CI ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
  },
})
