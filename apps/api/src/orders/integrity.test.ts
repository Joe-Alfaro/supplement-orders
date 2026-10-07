import { and, eq, sql } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { orderItems, orders, paymentAttempts, products } from '../db/schema'
import {
  as,
  createDraft,
  createSentOrder,
  moneyState,
  pay,
  patientQuote,
  setStock,
} from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 9 (DOMAIN_CONTRACT "payment integrity", Codex audit H1, H2, M2, M3, M4).
describe('revision 9: payment integrity and hardening', () => {
  let ctx: InternalTestContext

  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await ctx.close()
  })

  const provider = () => as(ctx.seed.providerUserId)

  function post(path: string, body?: object) {
    return ctx.request.post(path).set(provider()).send(body)
  }

  /** One line of the first seeded product at `unitPriceCents`, sent to the patient. */
  function sentAt(unitPriceCents: number) {
    return createSentOrder(ctx, [
      { productId: ctx.seed.products[0]!.id, quantity: 1, unitPriceCents },
    ])
  }

  async function reprice(orderId: number, unitPriceCents: number) {
    expect((await post(`/api/orders/${orderId}/cancel`)).status).toBe(200)
    expect((await post(`/api/orders/${orderId}/reopen`)).status).toBe(200)
    const edit = await ctx.request
      .put(`/api/orders/${orderId}/lines`)
      .set(provider())
      .send({
        lines: [
          { productId: ctx.seed.products[0]!.id, quantity: 1, unitPriceCents },
        ],
      })
    expect(edit.status).toBe(200)
    expect((await post(`/api/orders/${orderId}/send`)).status).toBe(200)
  }

  async function attemptsFor(orderId: number) {
    return ctx.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId))
  }

  describe('H1: pay is bound to the quote the patient saw', () => {
    it('counts sends in revision on both views', async () => {
      const orderId = await createDraft(ctx)
      const draft = await ctx.request
        .get(`/api/orders/${orderId}`)
        .set(provider())
      await post(`/api/orders/${orderId}/send`)
      const first = await patientQuote(ctx, orderId)
      await reprice(orderId, 3000)
      const second = await patientQuote(ctx, orderId)

      expect(draft.body.revision).toBe(0)
      expect(first.expectedRevision).toBe(1)
      expect(second).toEqual({ expectedRevision: 2, expectedTotalCents: 3000 })
    })

    it('refuses a stale screen after cancel, reopen, reprice and resend (audit repro)', async () => {
      const orderId = await sentAt(2000)
      const staleScreen = await patientQuote(ctx, orderId)
      await reprice(orderId, 3000)

      const stale = await pay(ctx, orderId, staleScreen)

      expect(stale.status).toBe(409)
      expect(stale.body.error).toEqual({
        code: 'ORDER_CHANGED',
        message:
          'This order changed since you opened it. Review the new total before paying.',
      })
      expect(ctx.gateway.charges).toEqual([])
      expect(await attemptsFor(orderId)).toEqual([])

      const fresh = await pay(ctx, orderId)
      expect(fresh.status).toBe(200)
      expect((await moneyState(ctx, orderId)).payments[0]!.amountCents).toBe(
        3000,
      )
    })

    it('refuses a wrong total or revision on an unchanged order', async () => {
      const orderId = await sentAt(2000)

      const total = await pay(ctx, orderId, { expectedTotalCents: 1999 })
      const revision = await pay(ctx, orderId, { expectedRevision: 2 })

      expect([total.status, total.body.error.code]).toEqual([
        409,
        'ORDER_CHANGED',
      ])
      expect([revision.status, revision.body.error.code]).toEqual([
        409,
        'ORDER_CHANGED',
      ])
      expect(ctx.gateway.charges).toEqual([])
    })

    it('replays a paid order only for the revision that was paid', async () => {
      const orderId = await sentAt(2000)
      const first = await pay(ctx, orderId)

      const same = await pay(ctx, orderId)
      const other = await pay(ctx, orderId, { expectedRevision: 2 })
      const wrongTotal = await pay(ctx, orderId, { expectedTotalCents: 1999 })

      expect(same.status).toBe(200)
      expect(same.body).toEqual(first.body)
      expect([other.status, other.body.error.code]).toEqual([
        409,
        'ORDER_CHANGED',
      ])
      expect([wrongTotal.status, wrongTotal.body.error.code]).toEqual([
        409,
        'ORDER_CHANGED',
      ])
      expect(ctx.gateway.charges).toHaveLength(1)
    })

    it('validates the pay body with a field', async () => {
      const orderId = await sentAt(2000)

      const res = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send({ expectedRevision: 1 })

      expect([res.status, res.body.error.field]).toEqual([
        400,
        'expectedTotalCents',
      ])
    })
  })

  describe('H2: durable payment attempts', () => {
    /** A charge that succeeds at the gateway and then rolls back in the database. */
    async function unreconciledCharge(orderId: number) {
      ctx.payHooks.afterLedgerInsert = async () => {
        throw new Error('database failure after the charge')
      }
      const res = await pay(ctx, orderId)
      delete ctx.payHooks.afterLedgerInsert
      expect(res.status).toBe(500)
    }

    it('records the attempt before charging and links the payment to it', async () => {
      const orderId = await sentAt(2000)

      await pay(ctx, orderId)

      const [attempt] = await attemptsFor(orderId)
      const { payments } = await moneyState(ctx, orderId)
      expect(attempt).toMatchObject({
        revision: 1,
        idempotencyKey: `order-${orderId}-r1`,
        amountCents: 2000,
        status: 'succeeded',
      })
      expect(payments[0]).toMatchObject({
        paymentAttemptId: attempt!.id,
        gatewayReference: attempt!.gatewayReference,
        amountCents: 2000,
      })
    })

    it('blocks cancel, reopen-path edits and delete while a charge is unreconciled', async () => {
      const orderId = await sentAt(2000)
      await unreconciledCharge(orderId)

      const [attempt] = await attemptsFor(orderId)
      expect(attempt?.status).toBe('succeeded')
      expect((await moneyState(ctx, orderId)).payments).toEqual([])

      const cancel = await post(`/api/orders/${orderId}/cancel`)
      expect([cancel.status, cancel.body.error.code]).toEqual([
        409,
        'PAYMENT_NEEDS_RECONCILIATION',
      ])
      // The audit's repricing path can't start: the order stays pending.
      const view = await ctx.request
        .get(`/api/orders/${orderId}`)
        .set(provider())
      expect(view.body.status).toBe('pending_payment')
    })

    it('a retried pay at the same revision completes the charge exactly once', async () => {
      const orderId = await sentAt(2000)
      await unreconciledCharge(orderId)
      const before = await moneyState(ctx, orderId)

      const retry = await pay(ctx, orderId)

      expect(retry.status).toBe(200)
      expect(retry.body.status).toBe('paid')
      const after = await moneyState(ctx, orderId)
      expect(after.payments).toHaveLength(1)
      expect(after.ledger).toHaveLength(3)
      const keys = new Set(ctx.gateway.charges.map((c) => c.idempotencyKey))
      expect([...keys]).toEqual([`order-${orderId}-r1`])
      const [attempt] = await attemptsFor(orderId)
      expect(after.payments[0]!.gatewayReference).toBe(
        attempt!.gatewayReference,
      )
      // The stock was reserved with the attempt and kept through the rollback;
      // completing the payment does not take it a second time.
      expect(after.stock).toEqual(before.stock)
      expect(before.stock[0]!.stockQuantity).toBe(
        ctx.seed.products[0]!.stockQuantity - 1,
      )
    })

    it('completes from the stored reference even if the gateway forgot the key (restart)', async () => {
      const orderId = await sentAt(2000)
      await unreconciledCharge(orderId)
      ctx.gateway.reset()

      const retry = await pay(ctx, orderId, { simulateFailure: true })

      // No new charge: the attempt's recorded success is used, not re-attempted.
      expect(retry.status).toBe(200)
      expect(ctx.gateway.charges).toEqual([])
    })

    it('maps a key reused for another amount to 409 and never records a payment', async () => {
      const orderId = await sentAt(2000)
      await ctx.gateway.charge({
        amountCents: 1500,
        idempotencyKey: `order-${orderId}-r1`,
        description: 'an earlier charge under the same key',
      })

      const res = await pay(ctx, orderId)

      expect([res.status, res.body.error.code]).toEqual([
        409,
        'IDEMPOTENCY_KEY_REUSED',
      ])
      expect((await moneyState(ctx, orderId)).payments).toEqual([])
      expect((await attemptsFor(orderId))[0]?.status).toBe('failed')
    })

    it('refuses to record a payment whose charged amount differs from the quote', async () => {
      const orderId = await sentAt(2000)
      vi.spyOn(ctx.gateway, 'charge').mockResolvedValue({
        status: 'succeeded',
        reference: 'fake_ch_wrong_amount',
        amountCents: 1999,
      })

      const res = await pay(ctx, orderId)

      expect(res.status).toBe(500)
      expect((await moneyState(ctx, orderId)).payments).toEqual([])
      // The charge is durable and blocks the order until it is reconciled.
      expect((await attemptsFor(orderId))[0]).toMatchObject({
        status: 'succeeded',
        gatewayReference: 'fake_ch_wrong_amount',
      })
      const cancel = await post(`/api/orders/${orderId}/cancel`)
      expect(cancel.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')
    })

    it('a declined attempt does not block, and its key can be retried', async () => {
      const orderId = await sentAt(2000)

      const declined = await pay(ctx, orderId, { simulateFailure: true })
      const retried = await pay(ctx, orderId)

      expect(declined.status).toBe(402)
      expect(retried.status).toBe(200)
      expect(await attemptsFor(orderId)).toHaveLength(1)
    })

    it('a reopened draft with a failed attempt can still be deleted', async () => {
      const orderId = await sentAt(2000)
      await pay(ctx, orderId, { simulateFailure: true })
      await post(`/api/orders/${orderId}/cancel`)
      await post(`/api/orders/${orderId}/reopen`)

      const res = await ctx.request
        .delete(`/api/orders/${orderId}`)
        .set(provider())

      expect(res.status).toBe(204)
      expect(await attemptsFor(orderId)).toEqual([])
    })
  })

  describe('stock is reserved with the payment attempt', () => {
    /** Two orders for one unit each of a product with exactly one in stock. */
    async function lastUnit() {
      const product = ctx.seed.products[0]!
      const line = { productId: product.id, quantity: 1, unitPriceCents: 2000 }
      const first = await createSentOrder(ctx, [line])
      const second = await createSentOrder(ctx, [line])
      await setStock(ctx, product.id, 1)
      return { productId: product.id, first, second }
    }

    async function stockOf(productId: number) {
      const [row] = await ctx.db
        .select({ stock: products.stockQuantity })
        .from(products)
        .where(eq(products.id, productId))
      return row!.stock
    }

    it('lets exactly one of two concurrent pays take the last unit; the other is refused before charging', async () => {
      const { productId, first, second } = await lastUnit()

      const results = await Promise.all([pay(ctx, first), pay(ctx, second)])

      expect(results.map((r) => r.status).sort()).toEqual([200, 422])
      const loser = results.find((r) => r.status === 422)!
      expect(loser.body.error).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        field: 'lines.0.quantity',
      })
      expect(ctx.gateway.charges).toHaveLength(1)
      expect(await stockOf(productId)).toBe(0)
      const loserId = results[0]!.status === 422 ? first : second
      expect(await attemptsFor(loserId)).toEqual([])
    })

    it('holds the unit while a charge is in flight, so another order is refused without charging', async () => {
      const { productId, first, second } = await lastUnit()
      const charge = ctx.gateway.charge.bind(ctx.gateway)
      const release = { resolve: () => {} }
      const held = new Promise<void>((resolve) => {
        release.resolve = resolve
      })
      vi.spyOn(ctx.gateway, 'charge').mockImplementationOnce(
        async (...args) => {
          await held
          return charge(...args)
        },
      )

      const paying = pay(ctx, first)
      // Wait until the first attempt has committed its reservation.
      await vi.waitFor(async () => expect(await stockOf(productId)).toBe(0))
      const refused = await pay(ctx, second)
      release.resolve()
      const paid = await paying

      expect([refused.status, refused.body.error.code]).toEqual([
        422,
        'INSUFFICIENT_STOCK',
      ])
      expect(paid.status).toBe(200)
      expect(ctx.gateway.charges).toHaveLength(1)
      expect(await stockOf(productId)).toBe(0)
    })

    it('gives the stock back exactly when the charge is declined', async () => {
      const orderId = await sentAt(2000)
      const before = (await moneyState(ctx, orderId)).stock

      const declined = await pay(ctx, orderId, { simulateFailure: true })

      expect(declined.status).toBe(402)
      expect((await moneyState(ctx, orderId)).stock).toEqual(before)
      expect((await attemptsFor(orderId))[0]).toMatchObject({
        status: 'failed',
        stockHeld: false,
      })
    })

    it('reserves once per attempt across a decline, a retry and a double click', async () => {
      const orderId = await sentAt(2000)
      const productId = ctx.seed.products[0]!.id
      const start = await stockOf(productId)

      await pay(ctx, orderId, { simulateFailure: true })
      const results = await Promise.all([pay(ctx, orderId), pay(ctx, orderId)])

      expect(results.map((r) => r.status)).toEqual([200, 200])
      expect(await stockOf(productId)).toBe(start - 1)
      expect((await attemptsFor(orderId))[0]).toMatchObject({
        status: 'succeeded',
        stockHeld: true,
      })
    })

    it('keeps the reservation of an unreconciled charge, so the unit cannot be sold twice', async () => {
      const { productId, first, second } = await lastUnit()
      ctx.payHooks.afterLedgerInsert = async () => {
        throw new Error('database failure after the charge')
      }
      expect((await pay(ctx, first)).status).toBe(500)
      delete ctx.payHooks.afterLedgerInsert

      const other = await pay(ctx, second)
      const completed = await pay(ctx, first)

      expect([other.status, other.body.error.code]).toEqual([
        422,
        'INSUFFICIENT_STOCK',
      ])
      expect(completed.status).toBe(200)
      expect(await stockOf(productId)).toBe(0)
    })
  })

  describe('M2: stock is locked in product-id order', () => {
    it('pays two orders with products in opposite line order without deadlocking', async () => {
      const [a, b] = ctx.seed.products
      const forward = await createSentOrder(ctx, [
        { productId: a!.id, quantity: 1, unitPriceCents: a!.cogsCents * 2 },
        { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents * 2 },
      ])
      const backward = await createSentOrder(ctx, [
        { productId: b!.id, quantity: 1, unitPriceCents: b!.cogsCents * 2 },
        { productId: a!.id, quantity: 1, unitPriceCents: a!.cogsCents * 2 },
      ])
      // As in the audit's probe: slow every stock update so the two
      // transactions overlap while holding their first product row.
      await ctx.db.execute(sql`
        create or replace function slow_stock_update() returns trigger as $$
        begin perform pg_sleep(0.2); return new; end $$ language plpgsql`)
      await ctx.db.execute(sql`
        create trigger slow_stock before update on products
        for each row execute function slow_stock_update()`)
      try {
        const results = await Promise.all([
          pay(ctx, forward),
          pay(ctx, backward),
        ])

        expect(results.map((r) => r.status)).toEqual([200, 200])
      } finally {
        await ctx.db.execute(sql`drop trigger if exists slow_stock on products`)
        await ctx.db.execute(sql`drop function if exists slow_stock_update()`)
      }
    })
  })

  describe('M3: draft bounds', () => {
    it('rejects out-of-bounds lines with a field and keeps the saved draft', async () => {
      const orderId = await createDraft(ctx)
      const before = await ctx.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
      const productId = ctx.seed.products[0]!.id

      const results = await Promise.all(
        [
          [{ productId, quantity: 1001 }, 'lines.0.quantity'],
          [{ productId, quantity: 2_147_483_648 }, 'lines.0.quantity'],
          [{ productId, unitPriceCents: 1_000_001 }, 'lines.0.unitPriceCents'],
          [
            { productId, unitPriceCents: Number.MAX_SAFE_INTEGER },
            'lines.0.unitPriceCents',
          ],
        ].map(async ([line, field]) => {
          const res = await ctx.request
            .put(`/api/orders/${orderId}/lines`)
            .set(provider())
            .send({ lines: [line] })
          return [res.status, res.body.error.field, field]
        }),
      )

      results.forEach(([status, actual, expected]) => {
        expect(status).toBe(400)
        expect(actual).toBe(expected)
      })
      const after = await ctx.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
      expect(after).toEqual(before)
    })

    it('accepts the bounds themselves', async () => {
      const orderId = await createDraft(ctx, [])

      const res = await ctx.request
        .put(`/api/orders/${orderId}/lines`)
        .set(provider())
        .send({
          lines: [
            {
              productId: ctx.seed.products[0]!.id,
              quantity: 1000,
              unitPriceCents: 1_000_000,
            },
          ],
        })

      expect(res.status).toBe(200)
      expect(res.body.lines[0].lineTotalCents).toBe(1_000_000_000)
    })

    it('still loads a draft saved before the bounds, rendering unsafe values as null', async () => {
      const orderId = await createDraft(ctx)
      await ctx.db
        .update(orderItems)
        .set({ unitPriceCents: Number.MAX_SAFE_INTEGER, quantity: 5000 })
        .where(
          and(
            eq(orderItems.orderId, orderId),
            eq(orderItems.productId, ctx.seed.products[0]!.id),
          ),
        )

      const res = await ctx.request
        .get(`/api/orders/${orderId}`)
        .set(provider())

      expect(res.status).toBe(200)
      expect(res.body.lines[0]).toMatchObject({
        unitPriceCents: Number.MAX_SAFE_INTEGER,
        lineTotalCents: null,
        markupBps: null,
      })
      expect(res.body.split).toBeNull()
    })
  })

  describe('M4: dashboard', () => {
    it('refuses to report a total beyond the exact cent range', async () => {
      const orderId = await sentAt(2000)
      await pay(ctx, orderId)
      // Push the recorded payment past 2^53 directly; no API path can do this.
      await ctx.db.execute(
        sql`update payments set amount_cents = 9007199254740993 where order_id = ${orderId}`,
      )

      const res = await ctx.request.get('/api/dashboard').set(provider())

      expect([res.status, res.body.error.code]).toEqual([500, 'INTERNAL'])
    })

    it('reports one consistent snapshot of the three totals', async () => {
      const orderId = await sentAt(2000)
      await pay(ctx, orderId)

      const res = await ctx.request.get('/api/dashboard').set(provider())

      expect(res.body.gmvCents).toBe(
        res.body.providerMarginCents +
          res.body.platformFeeCents +
          ctx.seed.products[0]!.cogsCents,
      )
    })
  })

  it('keeps every order row constraint-valid across the lifecycle', async () => {
    const orderId = await sentAt(2000)
    await reprice(orderId, 2500)
    await pay(ctx, orderId)

    const [row] = await ctx.db
      .select({ revision: orders.revision, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))

    expect(row).toEqual({ revision: 2, status: 'paid' })
  })
})
