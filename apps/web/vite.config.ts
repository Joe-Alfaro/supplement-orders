import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// `--mode e2e` (npm run e2e:web) proxies to the e2e API on 3100 instead of the
// dev API on 3000, so end-to-end runs never touch the dev servers or database.
function apiTarget(mode: string) {
  if (process.env.API_URL) return process.env.API_URL
  return mode === 'e2e' ? 'http://localhost:3100' : 'http://localhost:3000'
}

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': apiTarget(mode),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // userEvent typing through PrimeVue inputs is slow when the machine is busy
    // (parallel sessions); 5s timed out under load though no assertion failed.
    // The shared CI runner is CPU-starved (pipeline 44683: ~11 tests took 10-29s),
    // so CI gets generous timeouts and fewer workers to reduce contention.
    testTimeout: process.env.CI ? 60_000 : 15_000,
    ...(process.env.CI ? { hookTimeout: 60_000, maxWorkers: 2 } : {}),
  },
}))
