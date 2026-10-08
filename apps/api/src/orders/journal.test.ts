import { expectedPayableLinesOf, minUnitPriceCents } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  as,
  createSentOrder,
  pay,
  setStock,
  withPaidOrdersUnfrozen,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

interface PostingRow extends Record<string, unknown> {
  journal_id: number
  payment_id: number
  code: string
  amount: string
}
interface DisplayPosting {
  accountCode: string
  accountName: string
  debitCents: number | null
  creditCents: number | null
}
function noAccounting(value: unknown) {
  if (!value || typeof value !== 'object') return
  Object.entries(value).forEach(([key, child]) => {
    expect(key).not.toMatch(
      /journal|posting|ledger|accountCode|accountName|debitCents|creditCents/i,
    )
    noAccounting(child)
  })
}

describe('revision 16 payment journals and provider detail', () => {
  let ctx: InternalTestContext
  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx?.close()
  })
  function detail(id: number, user = ctx.seed.providerUserId) {
    return ctx.request.get(`/api/orders/${id}`).set(as(user))
  }
  async function assertJournal(id: number, total: number, cogs: number) {
    const fee = Math.ceil((total * 75) / 10000)
    const margin = total - cogs - fee
    const rows = (
      await ctx.db.execute<PostingRow>(sql`
      select j.id as journal_id, j.payment_id, a.code, p.amount_cents::text as amount
      from journals j join postings p on p.journal_id = j.id join accounts a on a.id = p.account_id
      where j.order_id = ${id}`)
    ).rows
    const provider = await detail(id)
    expect(provider.status).toBe(200)
    expect(new Set(rows.map((row) => row.journal_id)).size).toBe(1)
    expect(new Set(rows.map((row) => row.payment_id)).size).toBe(1)
    const expected = [
      { code: '1000', amount: String(total) },
      { code: '4000', amount: String(-cogs) },
      { code: '4100', amount: String(-fee) },
      { code: `2100-${provider.body.providerId}`, amount: String(-margin) },
    ].filter((row) => row.amount !== '0')
    expect(
      rows
        .map(({ code, amount }) => ({ code, amount }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    ).toEqual(expected.sort((a, b) => a.code.localeCompare(b.code)))
    expect(rows.reduce((sum, row) => sum + BigInt(row.amount), 0n)).toBe(0n)
    expect(provider.body).not.toHaveProperty('ledger')
    expect(provider.body.split).toMatchObject({
      totalCents: total,
      cogsCents: cogs,
      platformFeeCents: fee,
      providerMarginCents: margin,
    })
    const journal = provider.body.journal
    expect(Object.keys(journal).sort()).toEqual([
      'id',
      'memo',
      'postedAt',
      'postings',
    ])
    expect(journal.id).toBe(rows[0]!.journal_id)
    expect(typeof journal.memo).toBe('string')
    expect(Number.isNaN(Date.parse(journal.postedAt))).toBe(false)
    const displayed: DisplayPosting[] = journal.postings
    expect(displayed).toHaveLength(expected.length)
    displayed.forEach((row) => {
      expect(Object.keys(row).sort()).toEqual([
        'accountCode',
        'accountName',
        'creditCents',
        'debitCents',
      ])
      expect(row.accountName.length).toBeGreaterThan(0)
      const amount = Number(
        expected.find((item) => item.code === row.accountCode)!.amount,
      )
      expect(row.debitCents).toBe(amount > 0 ? amount : null)
      expect(row.creditCents).toBe(amount < 0 ? -amount : null)
    })
    expect(displayed.reduce((sum, row) => sum + (row.debitCents ?? 0), 0)).toBe(
      total,
    )
    expect(
      displayed.reduce((sum, row) => sum + (row.creditCents ?? 0), 0),
    ).toBe(total)
  }

  it.each([false, true])(
    'pay and retry create exactly one journal (zero margin: %s)',
    async (minimum) => {
      const product = ctx.seed.products[0]!
      const price = minimum ? minUnitPriceCents(product.cogsCents) : 12000
      const id = await createSentOrder(ctx, [
        { productId: product.id, quantity: 1, unitPriceCents: price },
      ])
      expect((await pay(ctx, id)).status).toBe(200)
      expect((await pay(ctx, id)).status).toBe(200)
      await assertJournal(id, price, product.cogsCents)
    },
  )

  it('each partial payment and its back-order payment gets a separate balanced journal', async () => {
    const product = ctx.seed.products[0]!
    const price = 2000
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 3, unitPriceCents: price },
    ])
    await setStock(ctx, product.id, 1)
    const quote = await detail(id, ctx.seed.patientUserId)
    const partial = await pay(ctx, id, {
      mode: 'available',
      expectedTotalCents: quote.body.partialPaymentQuote.pay.totalCents,
      expectedPayableLines: expectedPayableLinesOf(quote.body.lines),
    })
    expect(partial.status).toBe(200)
    const backorderId: number = (await detail(id)).body.backorderOrderId
    expect(backorderId).toEqual(expect.any(Number))
    await assertJournal(id, price, product.cogsCents)
    expect(
      (
        await ctx.db.execute(
          sql`select id from journals where order_id = ${backorderId}`,
        )
      ).rows,
    ).toHaveLength(0)
    await setStock(ctx, product.id, 2)
    expect((await pay(ctx, backorderId)).status).toBe(200)
    await assertJournal(backorderId, price * 2, product.cogsCents * 2)
    const rows = (
      await ctx.db.execute(sql`select id, payment_id from journals`)
    ).rows
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.payment_id)).size).toBe(2)
  })

  it('provider split reads postings even when a historical order snapshot differs', async () => {
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 1, unitPriceCents: 12000 },
    ])
    expect((await pay(ctx, id)).status).toBe(200)
    // Fixture-only override, using the established migration-0013 test helper.
    // This distinguishes posting reads from recalculating the line-price split.
    await withPaidOrdersUnfrozen(ctx.db, async (tx) => {
      await tx.execute(
        sql`update order_items set unit_cogs_cents = unit_cogs_cents + 100 where order_id = ${id}`,
      )
    })
    await assertJournal(id, 12000, product.cogsCents)
    const dashboard = await ctx.request
      .get('/api/dashboard?range=all')
      .set(as(ctx.seed.providerUserId))
    expect(dashboard.status).toBe(200)
    expect(dashboard.body).toMatchObject({
      gmvCents: 12000,
      platformFeeCents: 90,
      providerMarginCents: 12000 - product.cogsCents - 90,
      owedToYouCents: 12000 - product.cogsCents - 90,
    })
  })

  it('patient pay, detail and list DTOs never expose accounting fields', async () => {
    const id = await createSentOrder(ctx)
    noAccounting((await detail(id, ctx.seed.patientUserId)).body)
    const paid = await pay(ctx, id)
    expect(paid.status).toBe(200)
    noAccounting(paid.body)
    const read = await detail(id, ctx.seed.patientUserId)
    expect(read.status).toBe(200)
    noAccounting(read.body)
    const list = await ctx.request
      .get('/api/orders')
      .set(as(ctx.seed.patientUserId))
    expect(list.status).toBe(200)
    noAccounting(list.body)
  })

  it('failed gateway payment leaves no payment journal or postings', async () => {
    const id = await createSentOrder(ctx)
    expect((await pay(ctx, id, { simulateFailure: true })).status).toBe(402)
    expect((await ctx.db.execute(sql`select * from journals`)).rows).toEqual([])
    expect((await ctx.db.execute(sql`select * from postings`)).rows).toEqual([])
    expect((await ctx.db.execute(sql`select * from payments`)).rows).toEqual([])
  })

  // The current harness migrates to HEAD before seeding and offers no migration
  // cutoff. Per task authorization this is the API equivalence fallback, not a
  // claim to exercise 0014 against a pre-migration database.
  it('backfill fallback: legacy three-bucket equivalents become matching journals and balance globally', async () => {
    const product = ctx.seed.products[0]!
    await [12000, minUnitPriceCents(product.cogsCents), 2000].reduce(
      async (previous, total) => {
        await previous
        const id = await createSentOrder(ctx, [
          { productId: product.id, quantity: 1, unitPriceCents: total },
        ])
        expect((await pay(ctx, id)).status).toBe(200)
        await assertJournal(id, total, product.cogsCents)
      },
      Promise.resolve(),
    )
    const balance = await ctx.request
      .get('/api/admin/accounts')
      .set(as(ctx.seed.adminUserId))
    expect(balance.status).toBe(200)
    expect(balance.body.totals.debitsCents).toBe(
      12000 + minUnitPriceCents(product.cogsCents) + 2000,
    )
    expect(balance.body.totals.creditsCents).toBe(
      balance.body.totals.debitsCents,
    )
  })
})
