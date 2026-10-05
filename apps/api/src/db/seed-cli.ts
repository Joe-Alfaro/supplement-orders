import { loadConfig } from '../config'
import { createDb } from './client'
import { seedDatabase, truncateAll } from './seed'

// Resets the database to the seed state: all orders, payments and ledger rows are removed.
const { db, pool } = createDb(loadConfig().DATABASE_URL)

try {
  await truncateAll(db)
  const result = await seedDatabase(db)
  const patientCount = result.providers.flatMap((p) => p.patients).length
  console.log(
    `Seeded ${result.providers.length} providers, ${patientCount} patients, ${result.products.length} products`,
  )
} finally {
  await pool.end()
}
