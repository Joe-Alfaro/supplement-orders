import { rmSync } from 'node:fs'
import { minUnitPriceCents } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createInternalTestContext } from '../testing/harness'
import {
  migrationsThrough,
  recreateDatabase,
  scratchUrl,
} from '../testing/scratch-db'
import { runMigrations } from './migrate'

// Revision 20.1: migration 0018 gives every existing provider a default price
// for every existing product, at minUnitPriceCents(cost).

const LAST_PRE_DEFAULT_PRICES_MIGRATION = 17

describe('migration 0018: provider default prices over existing data', () => {
  const folder = migrationsThrough(LAST_PRE_DEFAULT_PRICES_MIGRATION)

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('backfills every provider x product at the minimum', async () => {
    const databaseUrl = scratchUrl('mig0018')
    await recreateDatabase(databaseUrl)
    const ctx = await createInternalTestContext({
      databaseUrl,
      migrationsFolder: folder,
    })
    try {
      await ctx.db.execute(sql`
        insert into products (sku, name, cogs_cents, stock_quantity)
        values ('FREE-1', 'Free sample', 0, 3), ('PRICEY-1', 'Pricey', 123457, 3)`)

      await runMigrations(ctx.db)

      const rows = (
        await ctx.db.execute<{
          provider_id: number
          product_id: number
          unit_price_cents: string
          cogs_cents: string
        }>(sql`
        select ppp.provider_id, ppp.product_id,
          ppp.unit_price_cents::text, p.cogs_cents::text
        from provider_product_prices ppp join products p on p.id = ppp.product_id`)
      ).rows
      const providerCount = (
        await ctx.db.execute<{ n: number }>(
          sql`select count(*)::int as n from providers`,
        )
      ).rows[0]!.n
      const productCount = (
        await ctx.db.execute<{ n: number }>(
          sql`select count(*)::int as n from products`,
        )
      ).rows[0]!.n
      expect(providerCount).toBe(2)
      expect(productCount).toBe(ctx.seed.products.length + 2)
      expect(rows).toHaveLength(providerCount * productCount)
      rows.forEach((row) => {
        expect(Number(row.unit_price_cents)).toBe(
          Math.max(1, minUnitPriceCents(Number(row.cogs_cents))),
        )
      })
    } finally {
      await ctx.close()
    }
  }, 120_000)
})
