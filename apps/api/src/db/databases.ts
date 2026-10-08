import { createHash } from 'node:crypto'
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
  return (
    env.E2E_DATABASE_URL ?? siblingDatabaseUrl('supplement_orders_e2e', env)
  )
}

const TEST_PREFIX = 'supplement_orders_test_'
const MAX_IDENTIFIER = 63
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/**
 * The API test database name, unique per checkout so concurrent runs in
 * different worktrees never truncate each other's data:
 * TEST_DATABASE_NAME, else `supplement_orders_test_<AO_SESSION_ID>`, else
 * `supplement_orders_test_<hash of the repo root>`.
 */
export function testDatabaseName(env: NodeJS.ProcessEnv, repoRoot: string) {
  const explicit = env.TEST_DATABASE_NAME
  if (explicit) {
    if (!PLAIN_IDENTIFIER.test(explicit)) {
      throw new Error(
        `TEST_DATABASE_NAME must match ${PLAIN_IDENTIFIER.source}, got "${explicit}"`,
      )
    }
    return explicit
  }

  const session = env.AO_SESSION_ID
  if (!session) return `${TEST_PREFIX}${shortHash(repoRoot)}`

  const suffix = session.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_')
  const name = `${TEST_PREFIX}${suffix}`
  if (name.length <= MAX_IDENTIFIER) return name
  // Too long to be a Postgres identifier: keep a readable prefix and make it
  // unique with a hash of the full session id.
  const hash = shortHash(session)
  return `${name.slice(0, MAX_IDENTIFIER - hash.length - 1)}_${hash}`
}

/** TEST_DATABASE_URL, else testDatabaseName() beside DATABASE_URL. */
export function testDatabaseUrl(env: NodeJS.ProcessEnv, repoRoot: string) {
  return (
    env.TEST_DATABASE_URL ??
    siblingDatabaseUrl(testDatabaseName(env, repoRoot), env)
  )
}
