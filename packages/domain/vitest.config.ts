import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The shared CI runner is CPU-starved; give slow tests headroom there only.
    ...(process.env.CI ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
  },
})
