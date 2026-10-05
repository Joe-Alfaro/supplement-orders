import { loadConfig } from '../config'
import { createDb } from './client'
import { runMigrations } from './migrate'

const { db, pool } = createDb(loadConfig().DATABASE_URL)

try {
  await runMigrations(db)
  console.log('Migrations applied')
} finally {
  await pool.end()
}
