import { rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createSentOrder,
  insertPaymentJournal,
  insertSucceededAttempt,
  pay,
  as,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  add0017AppSchema,
  migrationCountInFolder,
  migrationsThrough,
  recreateDatabase,
  remove0017AppSchema,
  scratchUrl,
} from '../testing/scratch-db'
import { runMigrations } from './migrate'

// Revision 19.2: migration 0017 checks every existing payment's provenance
// against its attempt. Scratch databases are migrated through 0016, given
// data by the current app (with 0017's columns briefly added), then migrated
// to the latest: real payments pass, and a mismatched one fails the migration.

const LAST_PRE_PROVENANCE_MIGRATION = 16

async function migrationCount(ctx: InternalTestContext) {
  const result = await ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  )
  return result.rows[0]!.n
}

describe('migration 0017: payment provenance over existing data', () => {
  const folder = migrationsThrough(LAST_PRE_PROVENANCE_MIGRATION)
  const contexts: InternalTestContext[] = []

  afterAll(async () => {
    await Promise.all(contexts.map((ctx) => ctx.close()))
    rmSync(folder, { recursive: true, force: true })
  })

  async function contextThrough0016(suffix: string) {
    const databaseUrl = scratchUrl(suffix)
    await recreateDatabase(databaseUrl)
    const ctx = await createInternalTestContext({
      databaseUrl,
      migrationsFolder: folder,
    })
    contexts.push(ctx)
    await add0017AppSchema(ctx.db)
    return ctx
  }

  it('applies over payments made by the app, which can still pay afterwards', async () => {
    const ctx = await contextThrough0016('mig0017ok')
    expect((await pay(ctx, await createSentOrder(ctx))).status).toBe(200)
    await remove0017AppSchema(ctx.db)

    await runMigrations(ctx.db)

    expect(await migrationCount(ctx)).toBe(migrationCountInFolder())
    expect((await pay(ctx, await createSentOrder(ctx))).status).toBe(200)
  }, 120_000)

  it('fails loudly on a payment whose reference differs from its attempt', async () => {
    const ctx = await contextThrough0016('mig0017bad')
    const orderId = await createSentOrder(ctx)
    const split = (
      await ctx.request
        .get(`/api/orders/${orderId}`)
        .set(as(ctx.seed.providerUserId))
    ).body.split as {
      totalCents: number
      cogsCents: number
      providerMarginCents: number
      platformFeeCents: number
    }
    // Valid under 0016: the attempt is succeeded on the same order.
    await ctx.db.transaction(async (tx) => {
      const attemptId = await insertSucceededAttempt(tx, {
        orderId,
        amountCents: split.totalCents,
        key: 'legacy',
      })
      const payment = await tx.execute<{ id: number }>(sql`
        insert into payments (order_id, amount_cents, idempotency_key, gateway_reference, payment_attempt_id)
        values (${orderId}, ${split.totalCents}, 'legacy', 'another-reference', ${attemptId})
        returning id`)
      await insertPaymentJournal(tx, {
        paymentId: payment.rows[0]!.id,
        orderId,
        cogsCents: split.cogsCents,
        marginCents: split.providerMarginCents,
        feeCents: split.platformFeeCents,
      })
      await tx.execute(
        sql`update orders set status = 'paid', paid_at = now() where id = ${orderId}`,
      )
    })
    await remove0017AppSchema(ctx.db)

    const failure = await runMigrations(ctx.db).then(
      () => null,
      (err: unknown) => err,
    )

    expect(failure).not.toBeNull()
    const { cause } = failure as { cause?: unknown }
    expect(String(cause ?? failure)).toMatch(/must match its attempt/)
    expect(await migrationCount(ctx)).toBe(LAST_PRE_PROVENANCE_MIGRATION + 1)
  }, 120_000)
})
