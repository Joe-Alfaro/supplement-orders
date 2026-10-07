import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { seedIfEmpty, truncateAll } from './seed'

// Named rows (including revision 13's admin) plus the bulk rows `db:seed` adds.
const FULL_SEED = { users: 253, patients: 250, providers: 2, products: 300 }

let ctx: InternalTestContext

async function counts() {
  const [row] = await ctx.db
    .execute<Record<keyof typeof FULL_SEED, string>>(
      sql`select
        (select count(*) from users) as users,
        (select count(*) from patients) as patients,
        (select count(*) from providers) as providers,
        (select count(*) from products) as products`,
    )
    .then((r) => r.rows)
  return {
    users: Number(row!.users),
    patients: Number(row!.patients),
    providers: Number(row!.providers),
    products: Number(row!.products),
  }
}

beforeAll(async () => {
  ctx = await createInternalTestContext()
})

beforeEach(async () => {
  await ctx.reset()
})

afterAll(async () => {
  // Leave the named seed behind for whichever test file runs next.
  await ctx.reset()
  await ctx.close()
})

describe('seedIfEmpty', () => {
  it('loads the full demo seed into an empty database', async () => {
    await truncateAll(ctx.db)

    const seeded = await seedIfEmpty(ctx.db)

    expect(seeded).toBe(true)
    expect(await counts()).toEqual(FULL_SEED)
    const [first] = await ctx.db
      .execute<{ id: number; name: string }>(
        sql`select id, name from users order by id limit 1`,
      )
      .then((r) => r.rows)
    expect(first).toEqual({ id: 1, name: 'Dr. Maya Rivera' })
  })

  it('seeds no two patients with the same full name', async () => {
    await truncateAll(ctx.db)

    await seedIfEmpty(ctx.db)

    const [row] = await ctx.db
      .execute<{ total: string; distinct: string }>(
        sql`select count(*) as total, count(distinct name) as distinct
          from users where role = 'patient'`,
      )
      .then((r) => r.rows)
    expect(row!.total).toBe(row!.distinct)
  })

  it('does nothing when users already exist', async () => {
    const before = await counts()

    const seeded = await seedIfEmpty(ctx.db)

    expect(seeded).toBe(false)
    expect(await counts()).toEqual(before)
  })

  it('is idempotent across repeated runs', async () => {
    await truncateAll(ctx.db)

    expect(await seedIfEmpty(ctx.db)).toBe(true)
    expect(await seedIfEmpty(ctx.db)).toBe(false)
    expect(await counts()).toEqual(FULL_SEED)
  })
})
