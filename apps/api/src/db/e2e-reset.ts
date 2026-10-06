import { createDb } from './client'
import { e2eDatabaseUrl, ensureDatabase } from './databases'
import { runMigrations } from './migrate'
import { seedDatabase, truncateAll } from './seed'

// `npm run e2e:db`: create supplement_orders_e2e if missing, migrate, truncate, and load the
// small named seed (no bulk rows), so every e2e run starts from the same state.
const url = e2eDatabaseUrl()
await ensureDatabase(url)
const { db, pool } = createDb(url)

try {
  await runMigrations(db)
  await truncateAll(db)
  const result = await seedDatabase(db)
  const patientCount = result.providers.flatMap((p) => p.patients).length
  console.log(
    `e2e database reset: ${new URL(url).pathname.slice(1)} with ${result.providers.length} providers, ${patientCount} patients, ${result.products.length} products`,
  )
} finally {
  await pool.end()
}
