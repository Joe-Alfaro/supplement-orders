import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // Test files in one run share this checkout's Postgres test database and
    // truncate it between tests, so they must not run concurrently. Separate
    // checkouts get separate databases (see testDatabaseName).
    fileParallelism: false,
  },
})
