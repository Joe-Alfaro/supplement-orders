import { loadConfig } from '../config'
import { createDb } from './client'
import { seedIfEmpty } from './seed'

// Safe on every deploy: seeds a fresh database once and never deletes data.
const { db, pool } = createDb(loadConfig().DATABASE_URL)

try {
  const seeded = await seedIfEmpty(db)
  console.log(
    seeded
      ? 'Database was empty: loaded the demo seed'
      : 'Database already has users: seed skipped',
  )
} finally {
  await pool.end()
}
