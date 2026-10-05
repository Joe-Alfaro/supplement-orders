import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const db = drizzle(pool, { schema })

  async function ping() {
    await db.execute(sql`select 1`)
  }

  return { db, pool, ping }
}

export type Db = ReturnType<typeof createDb>['db']
