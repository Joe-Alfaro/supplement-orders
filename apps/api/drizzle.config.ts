import { existsSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'
import { loadConfig } from './src/config'

// drizzle-kit does not read .env on its own; mirror the --env-file-if-exists used by the npm scripts.
if (existsSync('.env')) process.loadEnvFile('.env')

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: loadConfig().DATABASE_URL },
})
