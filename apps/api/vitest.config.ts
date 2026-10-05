import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // API tests share one Postgres test database and truncate it between tests,
    // so test files must not run concurrently.
    fileParallelism: false,
  },
})
