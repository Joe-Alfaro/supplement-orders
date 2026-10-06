import { z } from 'zod'

export const LOCAL_DATABASE_URL = 'postgres://supplement_orders:supplement_orders@localhost:54329/supplement_orders'

const envSchema = z.object({
  DATABASE_URL: z.url().default(LOCAL_DATABASE_URL),
  PORT: z.coerce.number().int().positive().default(3000),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}
