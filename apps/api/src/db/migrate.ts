import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Db } from './client'

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
)

/** Applies pending migrations; `migrationsFolder` is for migration tests only. */
export async function runMigrations(
  db: Db,
  migrationsFolder = MIGRATIONS_FOLDER,
) {
  await migrate(db, { migrationsFolder })
}
