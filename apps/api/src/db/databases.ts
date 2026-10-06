import pg from 'pg'
import { LOCAL_DATABASE_URL } from '../config'

/**
 * URL of a sibling database on the same server as DATABASE_URL (or the local
 * Docker Postgres), so tests and e2e never touch the dev database.
 */
export function siblingDatabaseUrl(name: string, env = process.env) {
  const url = new URL(env.DATABASE_URL ?? LOCAL_DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

/** Creates the database named in `url` if it does not exist yet. */
export async function ensureDatabase(url: string) {
  const dbName = new URL(url).pathname.slice(1)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    const existing = await client.query(
      'select 1 from pg_database where datname = $1',
      [dbName],
    )
    if (existing.rowCount === 0) {
      await client.query(`create database "${dbName.replaceAll('"', '""')}"`)
    }
  } finally {
    await client.end()
  }
}

/** The end-to-end database: E2E_DATABASE_URL, else `supplement_orders_e2e` beside DATABASE_URL. */
export function e2eDatabaseUrl(env = process.env) {
  return env.E2E_DATABASE_URL ?? siblingDatabaseUrl('supplement_orders_e2e', env)
}
