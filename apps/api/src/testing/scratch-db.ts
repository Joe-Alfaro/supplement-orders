import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import type { Db } from '../db/client'
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

/** How many migrations the real migrations folder holds. */
export function migrationCountInFolder(folder = MIGRATIONS_FOLDER) {
  const journal = JSON.parse(
    readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] }
  return journal.entries.length
}

/**
 * The columns, table and enum values that migrations 0016 (revision 18) and
 * 0017 (revision 19) add and the app's reads and writes now name. A scratch
 * database migrated to an earlier point gets them so the current app can make
 * its data there; removeLaterAppSchema takes them away again before the
 * remaining migrations run, so 0016 and 0017 apply as usual. Enum values
 * can't be dropped, so they stay, and 0016 and 0017 add theirs only if absent.
 */
export async function addLaterAppSchema(db: Db) {
  await addLaterEnumValues(db)
  await db.execute(sql`
    alter table orders add column merged_back_at timestamp with time zone;
    alter table payment_attempts add column reconciled_at timestamp with time zone;
    alter table payment_attempts add column reconciled_by_user_id integer;
    create table installation (
      singleton boolean primary key default true,
      install_id uuid not null default gen_random_uuid(),
      created_at timestamp with time zone not null default now()
    );
    insert into installation default values;`)
  await add0017AppSchema(db)
}

/**
 * The payment attempt statuses that 0016 and 0017 add, which the app's reads
 * name: enough for the current app to read a database migrated to an earlier
 * point.
 */
export async function addLaterEnumValues(db: Db) {
  await db.execute(sql`
    alter type payment_attempt_status add value if not exists 'abandoned';
    alter type payment_attempt_status add value if not exists 'late_success';
    alter type payment_attempt_status add value if not exists 'refund_required';`)
}

/** Only what 0017 adds, for a scratch database migrated through 0016. */
export async function add0017AppSchema(db: Db) {
  await addLaterEnumValues(db)
  await db.execute(sql`
    alter table payment_attempts add column refunded_at timestamp with time zone;
    alter table payment_attempts add column refunded_by_user_id integer;
    alter table fake_gateway_charges add column refunded_at timestamp with time zone;`)
}

export async function remove0017AppSchema(db: Db) {
  await db.execute(sql`
    alter table fake_gateway_charges drop column refunded_at;
    alter table payment_attempts drop column refunded_by_user_id;
    alter table payment_attempts drop column refunded_at;`)
}

export async function removeLaterAppSchema(db: Db) {
  await remove0017AppSchema(db)
  await db.execute(sql`
    drop table installation;
    alter table payment_attempts drop column reconciled_by_user_id;
    alter table payment_attempts drop column reconciled_at;
    alter table orders drop column merged_back_at;`)
}
