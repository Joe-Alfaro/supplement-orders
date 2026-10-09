import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSentOrder, insertPaymentJournal, pay } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { code, cause } = error as { code?: unknown; cause?: unknown }
  return typeof code === 'string' ? code : sqlState(cause)
}

interface Side {
  amountCents: number
  key: string
  reference: string
}

// Revision 19.2 (M3): the deferred provenance check in migration 0017. Seams:
// raw SQL in one transaction, so the check runs at commit like the app's own.
describe('revision 19.2 payment provenance matches its attempt exactly', () => {
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

  /** The auditor's reproduce.mts shape: a complete, balanced paid record. */
  async function commitPaid(
    orderId: number,
    attempt: Side & { revisionDelta?: number },
    payment: Side,
  ) {
    const cogs = ctx.seed.products[0]!.cogsCents
    return ctx.db.transaction(async (tx) => {
      const a = (
        await tx.execute<{ id: number }>(sql`
          insert into payment_attempts
            (order_id, revision, execution, idempotency_key, amount_cents, status, gateway_reference, stock_held)
          select id, revision + ${attempt.revisionDelta ?? 0}, 1, ${attempt.key},
            ${attempt.amountCents}, 'succeeded', ${attempt.reference}, true
          from orders where id = ${orderId}
          returning id`)
      ).rows[0]!
      const p = (
        await tx.execute<{ id: number }>(sql`
          insert into payments (order_id, amount_cents, idempotency_key, gateway_reference, payment_attempt_id)
          values (${orderId}, ${payment.amountCents}, ${payment.key}, ${payment.reference}, ${a.id})
          returning id`)
      ).rows[0]!
      await insertPaymentJournal(tx, {
        paymentId: p.id,
        orderId,
        cogsCents: cogs,
        marginCents: payment.amountCents - cogs - 38,
        feeCents: 38,
      })
      await tx.execute(
        sql`update orders set status = 'paid', paid_at = now() where id = ${orderId}`,
      )
    })
  }

  async function sentOrder() {
    const product = ctx.seed.products[0]!
    const id = await createSentOrder(ctx, [
      { productId: product.id, quantity: 1, unitPriceCents: 5000 },
    ])
    const order = (
      await ctx.db.execute<{ total_cents: string }>(
        sql`select total_cents from orders where id = ${id}`,
      )
    ).rows[0]!
    expect(Number(order.total_cents)).toBe(5000)
    return id
  }

  async function expectRejectedAndNothingCommitted(
    orderId: number,
    work: Promise<unknown>,
  ) {
    const error = await work.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(
      sqlState(error) ?? 'NO_ERROR',
      'a payment that disagrees with its attempt must be rejected at commit (SQLSTATE class 23)',
    ).toMatch(/^23/)
    expect((await ctx.db.execute(sql`select id from payments`)).rows).toEqual(
      [],
    )
    expect(
      (
        await ctx.db.execute(
          sql`select status from orders where id = ${orderId}`,
        )
      ).rows,
    ).toEqual([{ status: 'pending' }])
  }

  const matching: Side = { amountCents: 5000, key: 'key-A', reference: 'ref-A' }

  it("rejects the auditor's insert: attempt 1¢/key A/ref A, payment 5000¢/key B/ref B", async () => {
    const id = await sentOrder()
    await expectRejectedAndNothingCommitted(
      id,
      commitPaid(
        id,
        { amountCents: 1, key: 'key-A', reference: 'ref-A' },
        { amountCents: 5000, key: 'key-B', reference: 'ref-B' },
      ),
    )
  })

  it.each([
    ['amount', { ...matching, amountCents: 4999 }],
    ['idempotency key', { ...matching, key: 'key-other' }],
    ['gateway reference', { ...matching, reference: 'ref-other' }],
  ])(
    'rejects a payment whose %s alone differs from its attempt',
    async (_n, attempt) => {
      const id = await sentOrder()
      await expectRejectedAndNothingCommitted(
        id,
        commitPaid(id, attempt, matching),
      )
    },
  )

  it("rejects an attempt whose revision isn't the paid order's revision", async () => {
    const id = await sentOrder()
    await expectRejectedAndNothingCommitted(
      id,
      commitPaid(id, { ...matching, revisionDelta: 1 }, matching),
    )
  })

  it('accepts a payment that matches its attempt on amount, key, reference and revision', async () => {
    const id = await sentOrder()
    await commitPaid(id, matching, matching)
    expect(
      (await ctx.db.execute(sql`select status from orders where id = ${id}`))
        .rows,
    ).toEqual([{ status: 'paid' }])
    expect(
      (await ctx.db.execute(sql`select id from payments`)).rows,
    ).toHaveLength(1)
  })

  it('normal paths still pass: full payment and retry after a decline', async () => {
    const plain = await sentOrder()
    expect((await pay(ctx, plain)).status).toBe(200)

    const declined = await createSentOrder(ctx)
    expect((await pay(ctx, declined, { simulateFailure: true })).status).toBe(
      402,
    )
    expect((await pay(ctx, declined)).status).toBe(200)

    const rows = (
      await ctx.db.execute<{ same: boolean }>(sql`
        select p.amount_cents = a.amount_cents
          and p.idempotency_key = a.idempotency_key
          and p.gateway_reference = a.gateway_reference as same
        from payments p join payment_attempts a on a.id = p.payment_attempt_id`)
    ).rows
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.same)).toBe(true)
  })
})
