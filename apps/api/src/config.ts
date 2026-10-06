import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const LOCAL_DATABASE_URL = 'postgres://supplement_orders:supplement_orders@localhost:54329/supplement_orders'

/** Where `npm run build` puts the web app, relative to this file. */
export const DEFAULT_WEB_DIST = fileURLToPath(
  new URL('../../web/dist', import.meta.url),
)

const envSchema = z.object({
  DATABASE_URL: z.url().default(LOCAL_DATABASE_URL),
  PORT: z.coerce.number().int().positive().default(3000),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}

/**
 * The built web app the API should serve, if any. Production serves the
 * workspace build; SERVE_WEB_DIST overrides the path or turns serving on
 * elsewhere. Dev uses Vite's server instead.
 */
export function webDistDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.SERVE_WEB_DIST) return env.SERVE_WEB_DIST
  if (env.NODE_ENV === 'production') return DEFAULT_WEB_DIST
  return undefined
}
