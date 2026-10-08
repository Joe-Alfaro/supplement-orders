import { sql } from 'drizzle-orm'
import { loadConfig } from '../config'
import { createDb } from './client'
import { seedDatabase, truncateAll } from './seed'

// Resets the database to the seed state: all orders, payments and journals are removed.
const { db, pool } = createDb(loadConfig().DATABASE_URL)

try {
  await truncateAll(db)
  const result = await seedDatabase(db, { bulk: true })
  const [counts] = await db
    .execute<{ patients: string; products: string }>(
      sql`select (select count(*) from patients) as patients, (select count(*) from products) as products`,
    )
    .then((r) => r.rows)
  console.log(
    `Seeded ${result.providers.length} providers, ${counts?.patients} patients, ${counts?.products} products`,
  )
} finally {
  await pool.end()
}
