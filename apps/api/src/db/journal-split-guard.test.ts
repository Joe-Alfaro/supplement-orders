import { expectedPayableLinesOf } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { as, createSentOrder, pay, setStock } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  return typeof code === 'string' ? code : sqlState(cause)
}

describe('revision 17 direct SQL split and provenance guards', () => {
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

  it.each([
    'valid',
    'all-fee',
    'wrong-cogs',
    'wrong-fee',
    'null-attempt',
    'pending-attempt',
    'other-order-attempt',
    'wrong-provider',
  ] as const)('checks %s journal allocation at commit', async (mode) => {
    const product = ctx.seed.products[0]!
    const total = 2000
    const fee = 15
    const cogs = product.cogsCents
    const margin = total - cogs - fee
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 1, unitPriceCents: total },
    ])
    const otherId =
      mode === 'other-order-attempt'
        ? await createSentOrder(ctx, [
            { productId: product.id, quantity: 1, unitPriceCents: total },
          ])
        : id
    const reached = { end: false }
    const result = await ctx.db
      .transaction(async (tx) => {
        const attempt = (
          await tx.execute<{ id: number }>(sql`insert into payment_attempts
        (order_id, revision, idempotency_key, amount_cents, status, gateway_reference)
        select id, revision, 'rev17-attempt', ${total},
          ${mode === 'pending-attempt' ? 'pending' : 'succeeded'}::payment_attempt_status,
          ${mode === 'pending-attempt' ? null : 'rev17-reference'}
        from orders where id = ${otherId} returning id`)
        ).rows[0]!
        const payment = (
          await tx.execute<{ id: number }>(sql`insert into payments
        (order_id, amount_cents, idempotency_key, gateway_reference, payment_attempt_id)
        values (${id}, ${total}, 'rev17-attempt', 'rev17-reference', ${mode === 'null-attempt' ? null : attempt.id}) returning id`)
        ).rows[0]!
        const journal = (
          await tx.execute<{
            id: number
          }>(sql`insert into journals (kind, payment_id, order_id, memo)
        values ('patient_payment', ${payment.id}, ${id}, 'Revision 17 direct SQL') returning id`)
        ).rows[0]!
        const provider = (
          await tx.execute<{ id: number }>(
            sql`select id from providers where user_id = ${mode === 'wrong-provider' ? ctx.seed.otherProviderUserId : ctx.seed.providerUserId}`,
          )
        ).rows[0]!
        // Each wrong split still balances to zero, so only the split guard can reject it.
        const splits: Record<string, [string, number][]> = {
          'all-fee': [
            ['1000', total],
            ['4100', -total],
          ],
          'wrong-cogs': [
            ['1000', total],
            ['4000', -(cogs + 1)],
            ['4100', -fee],
            [`2100-${provider.id}`, -(margin - 1)],
          ],
          'wrong-fee': [
            ['1000', total],
            ['4000', -cogs],
            ['4100', -(fee + 1)],
            [`2100-${provider.id}`, -(margin - 1)],
          ],
        }
        const postings: [string, number][] = splits[mode] ?? [
          ['1000', total],
          ['4000', -cogs],
          ['4100', -fee],
          [`2100-${provider.id}`, -margin],
        ]
        expect(postings.reduce((sum, [, amount]) => sum + amount, 0)).toBe(0)
        await postings.reduce(async (previous, [code, amount]) => {
          await previous
          await tx.execute(sql`insert into postings (journal_id, account_id, amount_cents)
          values (${journal.id}, (select id from accounts where code = ${code}), ${amount})`)
        }, Promise.resolve())
        reached.end = true
      })
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      )
    // The callback must finish: a malformed fixture or immediate constraint is
    // not evidence that the deferred split guard worked.
    expect(reached.end).toBe(true)
    if (mode === 'valid') expect(result.error).toBeUndefined()
    else expect(sqlState(result.error) ?? 'COMMITTED').toMatch(/^23/)
    expect(
      (
        await ctx.db.execute(
          sql`select id from payments where order_id = ${id}`,
        )
      ).rows,
    ).toHaveLength(mode === 'valid' ? 1 : 0)
  })

  async function assertPaidJournal(id: number, total: number, cogs: number) {
    const fee = Math.ceil((total * 75) / 10000)
    const rows = (
      await ctx.db.execute(sql`select a.code, p.amount_cents::text as amount
      from journals j join postings p on p.journal_id = j.id join accounts a on a.id = p.account_id
      where j.order_id = ${id} order by a.code`)
    ).rows
    const provider = (
      await ctx.db.execute<{ provider_id: number }>(
        sql`select provider_id from orders where id = ${id}`,
      )
    ).rows[0]!
    expect(rows).toEqual([
      { code: '1000', amount: String(total) },
      {
        code: `2100-${provider.provider_id}`,
        amount: String(-(total - cogs - fee)),
      },
      { code: '4000', amount: String(-cogs) },
      { code: '4100', amount: String(-fee) },
    ])
    expect(
      (
        await ctx.db.execute(sql`select a.status, a.order_id from payments p
      join payment_attempts a on a.id = p.payment_attempt_id where p.order_id = ${id}`)
      ).rows,
    ).toEqual([{ status: 'succeeded', order_id: id }])
  }

  it('normal pay and retry preserve the correct split and succeeded provenance', async () => {
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 1, unitPriceCents: 2000 },
    ])
    expect((await pay(ctx, id)).status).toBe(200)
    expect((await pay(ctx, id)).status).toBe(200)
    await assertPaidJournal(id, 2000, product.cogsCents)
  })

  it('partial payment and subsequent back-order payment each commit their own correct split', async () => {
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 3, unitPriceCents: 2000 },
    ])
    await setStock(ctx, product.id, 1)
    const quote = await ctx.request
      .get(`/api/orders/${id}`)
      .set(as(ctx.seed.patientUserId))
    expect(quote.status).toBe(200)
    expect(
      (
        await pay(ctx, id, {
          mode: 'available',
          expectedTotalCents: 2000,
          expectedPayableLines: expectedPayableLinesOf(quote.body.lines),
        })
      ).status,
    ).toBe(200)
    const detail = await ctx.request
      .get(`/api/orders/${id}`)
      .set(as(ctx.seed.providerUserId))
    const backorderId: number = detail.body.backorderOrderId
    expect(backorderId).toEqual(expect.any(Number))
    await assertPaidJournal(id, 2000, product.cogsCents)
    await setStock(ctx, product.id, 2)
    expect((await pay(ctx, backorderId)).status).toBe(200)
    await assertPaidJournal(backorderId, 4000, product.cogsCents * 2)
    expect(
      (await ctx.db.execute(sql`select id from journals`)).rows,
    ).toHaveLength(2)
  })
})
