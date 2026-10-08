import { rmSync } from 'node:fs'
import {
  expectedPayableLinesOf,
  patientOrderDetailDtoSchema,
} from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  as,
  createSentOrder,
  insertPaymentJournal,
  pay,
  sampleLines,
  setStock,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  addLaterAppSchema,
  migrationCountInFolder,
  migrationsThrough,
  recreateDatabase,
  removeLaterAppSchema,
  scratchUrl,
} from '../testing/scratch-db'
import { runMigrations } from './migrate'

// Revision 17.3: migration 0015 checks every existing payment journal's split
// and provenance. Scratch databases are migrated through 0014, given data, then
// migrated to the latest: real payments pass, and a row that can't pass fails
// the migration instead of loosening the check. The current app makes the
// data, so the scratch databases briefly carry the schema later migrations
// add for it (addLaterAppSchema).

const LAST_PRE_SPLIT_CHECK_MIGRATION = 14

async function contextThrough0014(suffix: string, folder: string) {
  const databaseUrl = scratchUrl(suffix)
  await recreateDatabase(databaseUrl)
  const ctx = await createInternalTestContext({
    databaseUrl,
    migrationsFolder: folder,
  })
  await addLaterAppSchema(ctx.db)
  return ctx
}

async function migrationCount(ctx: InternalTestContext) {
  const result = await ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  )
  return result.rows[0]!.n
}

async function hasSplitCheck(ctx: InternalTestContext) {
  const result = await ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_proc where proname = 'assert_payment_journal'`,
  )
  return result.rows[0]!.n === 1
}

describe('migration 0015: the journal split check over existing data', () => {
  const folder = migrationsThrough(LAST_PRE_SPLIT_CHECK_MIGRATION)
  const contexts: InternalTestContext[] = []

  afterAll(async () => {
    await Promise.all(contexts.map((ctx) => ctx.close()))
    rmSync(folder, { recursive: true, force: true })
  })

  describe('with payments made by the app', () => {
    const holder: { ctx: InternalTestContext | null } = { ctx: null }
    function context() {
      if (!holder.ctx) throw new Error('scratch context not ready')
      return holder.ctx
    }

    beforeAll(async () => {
      const ctx = await contextThrough0014('mig0015ok', folder)
      contexts.push(ctx)
      holder.ctx = ctx

      // A full pay, then an available pay that splits off a back-order, then
      // the back-order once restocked.
      const full = await createSentOrder(ctx)
      expect((await pay(ctx, full)).status).toBe(200)
      const [, short] = sampleLines(ctx)
      const partial = await createSentOrder(ctx)
      await setStock(ctx, short!.productId, 0)
      const detail = patientOrderDetailDtoSchema.parse(
        (
          await ctx.request
            .get(`/api/orders/${partial}`)
            .set(as(ctx.seed.patientUserId))
        ).body,
      )
      const paidPartial = await ctx.request
        .post(`/api/orders/${partial}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send({
          expectedRevision: detail.revision,
          expectedTotalCents: detail.partialPaymentQuote!.pay.totalCents,
          mode: 'available',
          expectedPayableLines: expectedPayableLinesOf(detail.lines),
        })
      expect(paidPartial.status).toBe(200)
      await setStock(ctx, short!.productId, 10)
      const backorder = await ctx.db.execute<{ id: number }>(
        sql`select id from orders where split_from_order_id = ${partial}`,
      )
      expect((await pay(ctx, backorder.rows[0]!.id)).status).toBe(200)

      await removeLaterAppSchema(ctx.db)
      await runMigrations(ctx.db)
    }, 120_000)

    it('applies, with every existing payment passing', async () => {
      const ctx = context()
      expect(await migrationCount(ctx)).toBe(migrationCountInFolder())
      expect(await hasSplitCheck(ctx)).toBe(true)
      const paid = await ctx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from payments`,
      )
      expect(paid.rows[0]!.n).toBe(3)
    })

    it('still lets the app pay afterwards', async () => {
      const ctx = context()
      const orderId = await createSentOrder(ctx)
      expect((await pay(ctx, orderId)).status).toBe(200)
    })
  })

  describe('with a payment that has no attempt', () => {
    const holder: { ctx: InternalTestContext | null } = { ctx: null }

    beforeAll(async () => {
      const ctx = await contextThrough0014('mig0015bad', folder)
      contexts.push(ctx)
      holder.ctx = ctx

      // Valid under 0014: a balanced journal with the order's real split, but
      // the payment names no attempt.
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
      await ctx.db.transaction(async (tx) => {
        const payment = await tx.execute<{ id: number }>(sql`
          insert into payments (order_id, amount_cents, idempotency_key, gateway_reference)
          values (${orderId}, ${split.totalCents}, 'legacy', 'ref-legacy')
          returning id`)
        await insertPaymentJournal(tx, {
          paymentId: payment.rows[0]!.id,
          orderId,
          cogsCents: split.cogsCents,
          marginCents: split.providerMarginCents,
          feeCents: split.platformFeeCents,
        })
      })
    }, 120_000)

    it('fails the migration loudly and leaves the database at 0014', async () => {
      const ctx = holder.ctx!
      await removeLaterAppSchema(ctx.db)

      const failure = await runMigrations(ctx.db).then(
        () => null,
        (err: unknown) => err,
      )

      expect(failure).not.toBeNull()
      const { cause } = failure as { cause?: unknown }
      expect(String(cause ?? failure)).toMatch(
        /payment \d+ has no payment attempt/,
      )
      expect(await migrationCount(ctx)).toBe(LAST_PRE_SPLIT_CHECK_MIGRATION + 1)
      expect(await hasSplitCheck(ctx)).toBe(false)
    })
  })
})
