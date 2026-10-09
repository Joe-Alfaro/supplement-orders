import {
  adminPaymentAttemptListDtoSchema,
  reconcilePaymentAttemptDtoSchema,
} from '@supplement-orders/domain'
import { asc, eq, sql } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  fakeGatewayCharges,
  paymentAttempts,
  payments,
  products,
} from '../db/schema'
import type { ChargeRequest, ChargeResult } from '../seams/payment-gateway'
import { as, createSentOrder, pay } from '../testing/flows'
import {
  attemptKey,
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 19 (audit 7): no second charge after abandonment (19.1) and exact
// payment provenance in the database (19.2).

describe('revision 19', () => {
  let ctx: InternalTestContext

  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx?.close()
  })

  const provider = () => as(ctx.seed.providerUserId)
  const admin = () => as(ctx.seed.adminUserId)
  const product = () => ctx.seed.products[0]!

  async function sentOrder() {
    const a = product()
    return createSentOrder(ctx, [
      { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
    ])
  }

  async function stockOf(productId: number) {
    const [row] = await ctx.db
      .select({ stock: products.stockQuantity })
      .from(products)
      .where(eq(products.id, productId))
    return row!.stock
  }

  function attemptsOf(orderId: number) {
    return ctx.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId))
      .orderBy(asc(paymentAttempts.id))
  }

  async function succeededCharges() {
    return ctx.db
      .select()
      .from(fakeGatewayCharges)
      .where(eq(fakeGatewayCharges.status, 'succeeded'))
  }

  function reconcile(attemptId: number) {
    return ctx.request
      .post(`/api/admin/payment-attempts/${attemptId}/reconcile`)
      .set(admin())
  }

  function refund(attemptId: number) {
    return ctx.request
      .post(`/api/admin/payment-attempts/${attemptId}/refund`)
      .set(admin())
  }

  async function unresolved() {
    const res = await ctx.request
      .get('/api/admin/payment-attempts?status=unresolved')
      .set(admin())
    expect(res.status).toBe(200)
    return adminPaymentAttemptListDtoSchema.parse(res.body)
  }

  /**
   * Holds the next gateway charge before it reaches the gateway, the way a
   * slow network would, until `release` is called. Later charges pass.
   */
  function holdNextCharge() {
    const real = ctx.gateway.charge.bind(ctx.gateway)
    let release!: () => void
    let entered!: () => void
    const latch = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(ctx.gateway, 'charge').mockImplementationOnce(
      async (request: ChargeRequest, options): Promise<ChargeResult> => {
        entered()
        await latch
        return real(request, options)
      },
    )
    return { reached, release }
  }

  /** Abandons the order's only attempt on a clock 16 minutes later. */
  async function abandon(orderId: number) {
    const [attempt] = await attemptsOf(orderId)
    ctx.clock!.now = new Date(attempt!.createdAt.getTime() + 16 * 60_000)
    const res = await reconcile(attempt!.id)
    expect(res.status).toBe(200)
    expect(reconcilePaymentAttemptDtoSchema.parse(res.body).outcome).toBe(
      'abandoned',
    )
    return attempt!
  }

  /** A pay whose gateway call never left: 503, pending, then abandoned. */
  async function abandonedBeforeCharge() {
    const id = await sentOrder()
    vi.spyOn(ctx.gateway, 'charge').mockRejectedValueOnce(
      new Error('ECONNRESET'),
    )
    expect((await pay(ctx, id)).status).toBe(503)
    vi.restoreAllMocks()
    return { id, attempt: await abandon(id) }
  }

  /** The provider cancels, reopens and re-sends the order: a new revision. */
  async function cancelReopenResend(id: number) {
    expect(
      (await ctx.request.post(`/api/orders/${id}/cancel`).set(provider()))
        .status,
    ).toBe(200)
    expect(
      (await ctx.request.post(`/api/orders/${id}/reopen`).set(provider()))
        .status,
    ).toBe(200)
    const sent = await ctx.request
      .post(`/api/orders/${id}/send`)
      .set(provider())
      .send({ acknowledgeLowStock: true })
    expect(sent.status).toBe(200)
    return sent.body.revision as number
  }

  describe('19.1 no second charge after abandonment', () => {
    it("the auditor's interleaving: held call, +16 minutes, abandon, retry, release: one charge, one payment", async () => {
      const id = await sentOrder()
      const held = holdNextCharge()
      const original = pay(ctx, id)
      await held.reached
      const attempt = await abandon(id)

      const retry = await pay(ctx, id)
      expect(retry.status).toBe(200)
      held.release()
      const late = await original
      expect(late.status).toBe(200)
      const again = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attempt.id)).body,
      )
      expect(again.outcome).toBe('unchanged')

      expect(await succeededCharges()).toHaveLength(1)
      const recorded = await ctx.db.select().from(payments)
      expect(recorded).toHaveLength(1)
      const [charge] = await succeededCharges()
      expect(recorded[0]!.gatewayReference).toBe(charge!.reference)
      // The retry re-ran the abandoned execution: no second key.
      expect((await attemptsOf(id)).map((a) => a.idempotencyKey)).toEqual([
        attemptKey(ctx, id, 1, 1),
      ])
      expect(await unresolved()).toEqual([])
    })

    it('a retry after abandonment reuses the key and takes the stock again', async () => {
      const { id, attempt } = await abandonedBeforeCharge()
      const stockAfterAbandon = await stockOf(product().id)
      expect(await attemptsOf(id)).toMatchObject([
        { status: 'abandoned', stockHeld: false },
      ])

      const paid = await pay(ctx, id)
      expect(paid.status).toBe(200)
      expect(await attemptsOf(id)).toMatchObject([
        {
          id: attempt.id,
          idempotencyKey: attempt.idempotencyKey,
          status: 'succeeded',
          stockHeld: true,
        },
      ])
      expect(await stockOf(product().id)).toBe(stockAfterAbandon - 2)
      expect(await succeededCharges()).toHaveLength(1)
    })

    it('a success that landed after abandonment is recorded as late_success and finalizes the unpaid order once', async () => {
      const id = await sentOrder()
      const stockBefore = await stockOf(product().id)
      const held = holdNextCharge()
      const original = pay(ctx, id)
      await held.reached
      const attempt = await abandon(id)
      held.release()
      const late = await original
      expect(late.status).toBe(409)
      expect(late.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')
      const [charge] = await succeededCharges()
      expect(await attemptsOf(id)).toMatchObject([
        {
          status: 'late_success',
          gatewayReference: charge!.reference,
          stockHeld: false,
        },
      ])
      expect(await unresolved()).toMatchObject([
        {
          id: attempt.id,
          status: 'late_success',
          gatewayReference: charge!.reference,
          refundedAt: null,
        },
      ])
      // The patient can't start another charge while it is unresolved.
      const blocked = await pay(ctx, id)
      expect(blocked.status).toBe(409)
      expect(blocked.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')

      const done = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attempt.id)).body,
      )
      expect(done.outcome).toBe('finalized')
      expect(done.attempt).toMatchObject({
        status: 'succeeded',
        hasPayment: true,
      })
      expect(await ctx.db.select().from(payments)).toHaveLength(1)
      expect(await succeededCharges()).toHaveLength(1)
      expect(await stockOf(product().id)).toBe(stockBefore - 2)
      expect(await unresolved()).toEqual([])
    })

    it('a late success after the order was paid another way becomes refund_required, then refunded', async () => {
      const id = await sentOrder()
      const held = holdNextCharge()
      const original = pay(ctx, id)
      await held.reached
      const attempt = await abandon(id)

      // The provider changes the order; the patient pays the new revision.
      const revision = await cancelReopenResend(id)
      expect(revision).toBe(2)
      expect((await pay(ctx, id)).status).toBe(200)

      held.release()
      expect((await original).status).toBe(409)
      expect(await succeededCharges()).toHaveLength(2)
      expect(await unresolved()).toMatchObject([
        { id: attempt.id, status: 'late_success' },
      ])

      const settled = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attempt.id)).body,
      )
      expect(settled.outcome).toBe('refund_required')
      expect(settled.attempt).toMatchObject({
        status: 'refund_required',
        hasPayment: false,
        refundedAt: null,
      })
      expect(await unresolved()).toMatchObject([
        {
          id: attempt.id,
          status: 'refund_required',
          amountCents: attempt.amountCents,
        },
      ])
      expect(await ctx.db.select().from(payments)).toHaveLength(1)

      const refunded = reconcilePaymentAttemptDtoSchema.parse(
        (await refund(attempt.id)).body,
      )
      expect(refunded.outcome).toBe('refunded')
      expect(refunded.attempt.refundedAt).not.toBeNull()
      const [stored] = await ctx.db
        .select()
        .from(fakeGatewayCharges)
        .where(eq(fakeGatewayCharges.idempotencyKey, attempt.idempotencyKey))
      expect(stored!.refundedAt).not.toBeNull()
      expect(await unresolved()).toEqual([])
      expect(
        reconcilePaymentAttemptDtoSchema.parse((await refund(attempt.id)).body)
          .outcome,
      ).toBe('unchanged')
    })

    it('only a refund_required attempt can be refunded, and only by an admin', async () => {
      const { attempt } = await abandonedBeforeCharge()
      const res = await refund(attempt.id)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('NOT_REFUNDABLE')
      expect(
        (
          await ctx.request
            .post(`/api/admin/payment-attempts/${attempt.id}/refund`)
            .set(provider())
        ).status,
      ).toBe(403)
      expect((await refund(999_999)).status).toBe(404)
    })

    it('cancel and reopen after abandonment: the new revision gets a key only after the lookup finds nothing', async () => {
      const { id, attempt } = await abandonedBeforeCharge()
      const revision = await cancelReopenResend(id)
      const lookup = vi.spyOn(ctx.gateway, 'lookup')

      expect((await pay(ctx, id)).status).toBe(200)
      expect(lookup).toHaveBeenCalledWith(attempt.idempotencyKey)
      expect((await attemptsOf(id)).map((a) => a.idempotencyKey)).toEqual([
        attempt.idempotencyKey,
        attemptKey(ctx, id, revision, 1),
      ])
    })

    it('a new revision is blocked when the lookup finds the abandoned key charged, and no key is minted', async () => {
      const id = await sentOrder()
      const held = holdNextCharge()
      const original = pay(ctx, id)
      await held.reached
      const attempt = await abandon(id)
      await cancelReopenResend(id)
      // The held call reaches the gateway; its response is still in flight.
      const real = ctx.gateway.charge.bind(ctx.gateway)
      await real({
        amountCents: attempt.amountCents,
        idempotencyKey: attempt.idempotencyKey,
        description: 'the delayed original call',
      })

      const blocked = await pay(ctx, id)
      expect(blocked.status).toBe(409)
      expect(blocked.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')
      expect(await attemptsOf(id)).toMatchObject([
        { id: attempt.id, status: 'late_success' },
      ])
      // Lifecycle is blocked too until the admin settles it.
      expect(
        (await ctx.request.post(`/api/orders/${id}/cancel`).set(provider()))
          .status,
      ).toBe(409)

      // The charge was for an older quote, so it can't pay this one.
      const settled = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attempt.id)).body,
      )
      expect(settled.outcome).toBe('refund_required')
      expect((await pay(ctx, id)).status).toBe(200)
      held.release()
      expect((await original).status).toBe(409)
      expect(await ctx.db.select().from(payments)).toHaveLength(1)
      expect(await attemptsOf(id)).toMatchObject([
        { id: attempt.id, status: 'refund_required' },
        { status: 'succeeded' },
      ])
    })
  })

  describe('19.2 payment provenance matches exactly', () => {
    async function forge(
      overrides: Partial<{
        attemptAmount: number
        attemptKey: string
        attemptReference: string
        attemptRevision: number
        paymentKey: string
        paymentReference: string
      }> = {},
    ) {
      const id = await sentOrder()
      const [order] = (
        await ctx.db.execute(
          sql`select revision, total_cents, platform_fee_cents from orders where id = ${id}`,
        )
      ).rows as {
        revision: number
        total_cents: number
        platform_fee_cents: number
      }[]
      const total = Number(order!.total_cents)
      const fee = Number(order!.platform_fee_cents)
      const cogs = 2 * product().cogsCents
      const o = {
        attemptAmount: total,
        attemptKey: 'key-a',
        attemptReference: 'ref-a',
        attemptRevision: order!.revision,
        paymentKey: 'key-a',
        paymentReference: 'ref-a',
        ...overrides,
      }
      return ctx.db.transaction(async (tx) => {
        const a = (
          await tx.execute(sql`insert into payment_attempts
            (order_id, revision, execution, idempotency_key, amount_cents, status, gateway_reference, stock_held)
            values (${id}, ${o.attemptRevision}, 1, ${o.attemptKey}, ${o.attemptAmount}, 'succeeded', ${o.attemptReference}, true)
            returning id`)
        ).rows[0]!
        const p = (
          await tx.execute(sql`insert into payments
            (order_id, amount_cents, idempotency_key, gateway_reference, payment_attempt_id)
            values (${id}, ${total}, ${o.paymentKey}, ${o.paymentReference}, ${a.id})
            returning id`)
        ).rows[0]!
        const j = (
          await tx.execute(sql`insert into journals (kind, payment_id, order_id, memo)
            values ('patient_payment', ${p.id}, ${id}, 'forged') returning id`)
        ).rows[0]!
        await tx.execute(sql`insert into postings (journal_id, account_id, amount_cents)
          select ${j.id}, id, case code
            when '1000' then ${total}::bigint
            when '4000' then -(${cogs}::bigint)
            when '4100' then -(${fee}::bigint)
            else -(${total - cogs - fee}::bigint) end
          from accounts
          where code in ('1000', '4000', '4100', (select '2100-' || provider_id from orders where id = ${id}))`)
        await tx.execute(
          sql`update orders set status = 'paid', paid_at = now() where id = ${id}`,
        )
      })
    }

    it('a consistent forged payment still commits (the checks are not too strict)', async () => {
      await expect(forge()).resolves.toBeUndefined()
    })

    it("rejects the auditor's mismatch: attempt 1 cent with key A and reference A, payment with key B and reference B", async () => {
      await expect(
        forge({
          attemptAmount: 1,
          paymentKey: 'key-b',
          paymentReference: 'ref-b',
        }),
      ).rejects.toThrow()
      expect(await ctx.db.select().from(payments)).toHaveLength(0)
    })

    it.each([
      ['amount', { attemptAmount: 1 }],
      ['idempotency key', { paymentKey: 'key-b' }],
      ['gateway reference', { paymentReference: 'ref-b' }],
      ['revision', { attemptRevision: 7 }],
    ])('rejects a payment whose %s differs from its attempt', async (_, o) => {
      await expect(forge(o)).rejects.toThrow()
      expect(await ctx.db.select().from(payments)).toHaveLength(0)
    })
  })
})
