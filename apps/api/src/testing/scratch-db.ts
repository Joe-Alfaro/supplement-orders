import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ensureDatabase, testDatabaseUrl } from '../db/databases'
import { MIGRATIONS_FOLDER } from '../db/migrate'

// Migration tests only: scratch databases migrated to a chosen point.

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** This checkout's test database name with a suffix, kept a valid identifier. */
export function scratchUrl(suffix: string) {
  const url = new URL(testDatabaseUrl(process.env, REPO_ROOT))
  const base = url.pathname.slice(1).slice(0, 62 - suffix.length)
  url.pathname = `/${base}_${suffix}`
  return url.toString()
}

/** Drops and recreates the database named in `url`. */
export async function recreateDatabase(url: string) {
  const admin = new URL(url)
  const name = admin.pathname.slice(1)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    await client.query(
      `drop database if exists "${name.replaceAll('"', '""')}" with (force)`,
    )
  } finally {
    await client.end()
  }
  await ensureDatabase(url)
}

/** A copy of the migrations folder whose journal stops at migration `last`. */
export function migrationsThrough(last: number) {
  const folder = mkdtempSync(join(tmpdir(), 'supplement-orders-migrations-'))
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
  const journalPath = join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number }[]
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= last)
  writeFileSync(journalPath, JSON.stringify(journal))
  return folder
}
