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
import {
  fakeGatewayCharges,
  orderItems,
  orders,
  paymentAttempts,
  payments as paymentsTable,
  products,
} from '../db/schema'
import { FakePaymentGateway, fakeGatewaySucceededReferences } from '../seams'
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
  restartContext,
  type InternalTestContext,
} from '../testing/harness'

// Revisions 9 and 10 (DOMAIN_CONTRACT "payment integrity" and "execution-safe
// payments"; Codex audit H1-M4 and re-audit N1-N3).
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

  /** Successful references in the gateway's durable store vs recorded payments. */
  async function chargesAndPayments() {
    const charged = await fakeGatewaySucceededReferences(ctx.db)
    const recorded = await ctx.db
      .select({ reference: paymentsTable.gatewayReference })
      .from(paymentsTable)
    return {
      charged: [...charged].sort(),
      recorded: recorded.map((p) => p.reference).sort(),
    }
  }

  async function stockOf(productId: number) {
    const [row] = await ctx.db
      .select({ stock: products.stockQuantity })
      .from(products)
      .where(eq(products.id, productId))
    return row!.stock
  }

  /**
   * Lets the next gateway call reach the durable fake for real (so its outcome
   * is decided and stored), but holds the response until released, like a slow
   * network between the gateway and this API process.
   */
  function holdNextResponse() {
    const real = ctx.gateway.charge.bind(ctx.gateway)
    const reached = { resolve: () => {} }
    const release = { resolve: () => {} }
    const reachedP = new Promise<void>((resolve) => {
      reached.resolve = resolve
    })
    const releaseP = new Promise<void>((resolve) => {
      release.resolve = resolve
    })
    vi.spyOn(ctx.gateway, 'charge').mockImplementationOnce(async (...args) => {
      const result = await real(...args)
      reached.resolve()
      await releaseP
      return result
    })
    return { reached: reachedP, release: () => release.resolve() }
  }

  describe('H2 / revision 10: executions and the durable gateway', () => {
    /** A charge that succeeds at the gateway and then rolls back in the database. */
    async function unreconciledCharge(orderId: number) {
      ctx.payHooks.afterLedgerInsert = async () => {
        throw new Error('database failure after the charge')
      }
      const res = await pay(ctx, orderId)
      delete ctx.payHooks.afterLedgerInsert
      expect(res.status).toBe(500)
    }

    it('records execution 1 before charging and links the payment to it', async () => {
      const orderId = await sentAt(2000)

      await pay(ctx, orderId)

      const [attempt] = await attemptsFor(orderId)
      const { payments } = await moneyState(ctx, orderId)
      expect(attempt).toMatchObject({
        revision: 1,
        execution: 1,
        idempotencyKey: `order-${orderId}-r1-e1`,
        amountCents: 2000,
        status: 'succeeded',
        stockHeld: true,
      })
      expect(payments[0]).toMatchObject({
        paymentAttemptId: attempt!.id,
        gatewayReference: attempt!.gatewayReference,
      })
      expect(await chargesAndPayments()).toEqual({
        charged: [attempt!.gatewayReference],
        recorded: [attempt!.gatewayReference],
      })
    })

    it('blocks cancel, reopen, delete and edit while a success is unrecorded', async () => {
      const orderId = await sentAt(2000)
      await unreconciledCharge(orderId)

      const results = await Promise.all([
        post(`/api/orders/${orderId}/cancel`),
        post(`/api/orders/${orderId}/reopen`),
        ctx.request.delete(`/api/orders/${orderId}`).set(provider()),
        ctx.request
          .put(`/api/orders/${orderId}/lines`)
          .set(provider())
          .send({ lines: [] }),
      ])

      results.forEach((res) => {
        expect([res.status, res.body.error.code]).toEqual([
          409,
          'PAYMENT_NEEDS_RECONCILIATION',
        ])
      })
    })

    it('finalizes a recorded success by lookup, never by charging again', async () => {
      const orderId = await sentAt(2000)
      await unreconciledCharge(orderId)
      const callsBefore = ctx.gateway.charges.length

      // Even a request for a decline cannot touch a success the gateway holds.
      const retry = await pay(ctx, orderId, { simulateFailure: true })

      expect(retry.status).toBe(200)
      expect(ctx.gateway.charges).toHaveLength(callsBefore)
      const sets = await chargesAndPayments()
      expect(sets.charged).toEqual(sets.recorded)
      expect(sets.charged).toHaveLength(1)
    })

    it('refuses to finalize a success the gateway does not confirm', async () => {
      const orderId = await sentAt(2000)
      await unreconciledCharge(orderId)
      // The gateway's record no longer matches what the app recorded.
      await ctx.db
        .update(fakeGatewayCharges)
        .set({ reference: 'fake_ch_someone_else' })

      const retry = await pay(ctx, orderId)

      expect([retry.status, retry.body.error.code]).toEqual([
        409,
        'PAYMENT_NEEDS_RECONCILIATION',
      ])
      expect((await moneyState(ctx, orderId)).payments).toEqual([])
    })

    it('starts a new execution with a new key only after a definitive decline', async () => {
      const orderId = await sentAt(2000)
      const productId = ctx.seed.products[0]!.id
      const start = await stockOf(productId)

      const declined = await pay(ctx, orderId, { simulateFailure: true })
      expect(declined.status).toBe(402)
      expect(await stockOf(productId)).toBe(start)
      // Replaying the declined key would only replay the decline.
      const paid = await pay(ctx, orderId)

      expect(paid.status).toBe(200)
      expect(
        (await attemptsFor(orderId))
          .sort((a, b) => a.execution - b.execution)
          .map((a) => [a.execution, a.idempotencyKey, a.status, a.stockHeld]),
      ).toEqual([
        [1, `order-${orderId}-r1-e1`, 'declined', false],
        [2, `order-${orderId}-r1-e2`, 'succeeded', true],
      ])
      expect(await stockOf(productId)).toBe(start - 1)
    })

    it('reuses the pending execution for a double click: one charge, one reservation', async () => {
      const orderId = await sentAt(2000)
      const productId = ctx.seed.products[0]!.id
      const start = await stockOf(productId)

      const results = await Promise.all([pay(ctx, orderId), pay(ctx, orderId)])

      expect(results.map((r) => r.status)).toEqual([200, 200])
      expect(await attemptsFor(orderId)).toHaveLength(1)
      expect(await stockOf(productId)).toBe(start - 1)
      expect((await chargesAndPayments()).charged).toHaveLength(1)
    })

    it("refuses an older quote's unresolved execution before charging a new quote", async () => {
      const orderId = await sentAt(2000)
      await reprice(orderId, 3000)
      // An unresolved execution left on revision 1 (only reachable through bad data).
      await ctx.db.insert(paymentAttempts).values({
        orderId,
        revision: 1,
        execution: 1,
        idempotencyKey: `order-${orderId}-r1-e1`,
        amountCents: 2000,
        status: 'pending',
      })

      const res = await pay(ctx, orderId)

      expect([res.status, res.body.error.code]).toEqual([
        409,
        'PAYMENT_NEEDS_RECONCILIATION',
      ])
      expect(ctx.gateway.charges).toEqual([])
    })
  })

  describe('N1: overlapping gateway responses', () => {
    it('six steps, decline first: both pays get the same decline; repricing then charges exactly once', async () => {
      const orderId = await sentAt(2000)
      const holdA = holdNextResponse()
      const payA = pay(ctx, orderId, { simulateFailure: true })
      await holdA.reached
      const holdB = holdNextResponse()
      const payB = pay(ctx, orderId)
      await holdB.reached

      holdA.release()
      expect((await payA).status).toBe(402)
      await reprice(orderId, 3000)
      holdB.release()
      expect((await payB).status).toBe(402)
      const paid = await pay(ctx, orderId)

      expect(paid.status).toBe(200)
      const sets = await chargesAndPayments()
      expect(sets.charged).toEqual(sets.recorded)
      expect(sets.charged).toHaveLength(1)
      const { payments } = await moneyState(ctx, orderId)
      expect(payments.map((p) => p.amountCents)).toEqual([3000])
    })

    it('six steps, success first: a later decline request replays the success and the order cannot be repriced', async () => {
      const orderId = await sentAt(2000)
      const holdB = holdNextResponse()
      const payB = pay(ctx, orderId)
      await holdB.reached
      const holdA = holdNextResponse()
      const payA = pay(ctx, orderId, { simulateFailure: true })
      await holdA.reached

      // While both responses are in flight the order is locked down.
      const cancel = await post(`/api/orders/${orderId}/cancel`)
      expect([cancel.status, cancel.body.error.code]).toEqual([
        409,
        'PAYMENT_NEEDS_RECONCILIATION',
      ])
      holdA.release()
      holdB.release()
      const results = await Promise.all([payA, payB])

      expect(results.map((r) => r.status)).toEqual([200, 200])
      const sets = await chargesAndPayments()
      expect(sets.charged).toEqual(sets.recorded)
      expect(sets.charged).toHaveLength(1)
    })

    it('delete variant: an in-flight execution blocks the path to deleting the order', async () => {
      const orderId = await sentAt(2000)
      const hold = holdNextResponse()
      const paying = pay(ctx, orderId)
      await hold.reached

      const attempts = await Promise.all([
        post(`/api/orders/${orderId}/cancel`),
        ctx.request.delete(`/api/orders/${orderId}`).set(provider()),
      ])
      hold.release()

      attempts.forEach((res) => {
        expect(res.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')
      })
      expect((await paying).status).toBe(200)
      expect(await attemptsFor(orderId)).toHaveLength(1)
    })

    it('last-unit variant: a competing order cannot take a unit held by an in-flight execution', async () => {
      const product = ctx.seed.products[0]!
      const line = { productId: product.id, quantity: 1, unitPriceCents: 2000 }
      const first = await createSentOrder(ctx, [line])
      const second = await createSentOrder(ctx, [line])
      await setStock(ctx, product.id, 1)
      const hold = holdNextResponse()
      const paying = pay(ctx, first, { simulateFailure: true })
      await hold.reached

      const blocked = await pay(ctx, second)
      expect([blocked.status, blocked.body.error.code]).toEqual([
        422,
        'INSUFFICIENT_STOCK',
      ])
      hold.release()
      expect((await paying).status).toBe(402)
      // The decline released the unit; now the other order can have it.
      const paid = await pay(ctx, second)

      expect(paid.status).toBe(200)
      expect(await stockOf(product.id)).toBe(0)
      expect((await chargesAndPayments()).charged).toHaveLength(1)
    })
  })

  describe('N2: restart boundaries (fresh gateway and app, same database)', () => {
    it('after the success is recorded but before the payment commits', async () => {
      const orderId = await sentAt(2000)
      ctx.payHooks.afterLedgerInsert = async () => {
        throw new Error('crash before the payment commits')
      }
      expect((await pay(ctx, orderId)).status).toBe(500)

      restartContext(ctx)
      const retry = await pay(ctx, orderId)

      expect(retry.status).toBe(200)
      expect(ctx.gateway.charges).toEqual([])
      const sets = await chargesAndPayments()
      expect(sets.charged).toEqual(sets.recorded)
      expect(sets.charged).toHaveLength(1)
    })

    it('after the gateway succeeds but before its result is recorded', async () => {
      const orderId = await sentAt(2000)
      const real = ctx.gateway.charge.bind(ctx.gateway)
      vi.spyOn(ctx.gateway, 'charge').mockImplementationOnce(
        async (...args) => {
          await real(...args)
          throw new Error('crash after the gateway charged')
        },
      )
      expect((await pay(ctx, orderId)).status).toBe(500)
      expect((await attemptsFor(orderId))[0]?.status).toBe('pending')

      restartContext(ctx)
      const retry = await pay(ctx, orderId)

      expect(retry.status).toBe(200)
      const sets = await chargesAndPayments()
      expect(sets.charged).toEqual(sets.recorded)
      expect(sets.charged).toHaveLength(1)
    })

    it('before the gateway is called at all', async () => {
      const orderId = await sentAt(2000)
      vi.spyOn(ctx.gateway, 'charge').mockRejectedValueOnce(
        new Error('crash before charging'),
      )
      expect((await pay(ctx, orderId)).status).toBe(500)
      expect((await chargesAndPayments()).charged).toEqual([])

      restartContext(ctx)
      const retry = await pay(ctx, orderId)

      expect(retry.status).toBe(200)
      const sets = await chargesAndPayments()
      expect(sets.charged).toEqual(sets.recorded)
      expect(sets.charged).toHaveLength(1)
    })
  })

  describe('N3: a key conflict is unresolved, not a decline', () => {
    it('keeps the reservation and blocks cancel, reopen and delete', async () => {
      const orderId = await sentAt(2000)
      const productId = ctx.seed.products[0]!.id
      const start = await stockOf(productId)
      // Something already holds this execution's key at another amount.
      await ctx.gateway.charge({
        amountCents: 1999,
        idempotencyKey: `order-${orderId}-r1-e1`,
        description: 'an earlier charge under the same key',
      })

      const res = await pay(ctx, orderId)

      expect([res.status, res.body.error.code]).toEqual([
        409,
        'PAYMENT_NEEDS_RECONCILIATION',
      ])
      expect((await attemptsFor(orderId))[0]).toMatchObject({
        status: 'conflict',
        stockHeld: true,
      })
      expect(await stockOf(productId)).toBe(start - 1)
      const lifecycle = await Promise.all([
        post(`/api/orders/${orderId}/cancel`),
        post(`/api/orders/${orderId}/reopen`),
        ctx.request.delete(`/api/orders/${orderId}`).set(provider()),
      ])
      lifecycle.forEach((r) => {
        expect(r.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')
      })
      // A retry reuses the conflicted key and stays unresolved: no new key, no payment.
      expect((await pay(ctx, orderId)).body.error.code).toBe(
        'PAYMENT_NEEDS_RECONCILIATION',
      )
      expect(await attemptsFor(orderId)).toHaveLength(1)
      expect((await moneyState(ctx, orderId)).payments).toEqual([])
    })

    it('treats a success for another amount as a conflict too', async () => {
      const orderId = await sentAt(2000)
      vi.spyOn(ctx.gateway, 'charge').mockResolvedValueOnce({
        status: 'succeeded',
        reference: 'fake_ch_wrong_amount',
        amountCents: 1999,
      })

      const res = await pay(ctx, orderId)

      expect(res.body.error.code).toBe('PAYMENT_NEEDS_RECONCILIATION')
      expect((await attemptsFor(orderId))[0]?.status).toBe('conflict')
      expect((await moneyState(ctx, orderId)).payments).toEqual([])
    })
  })

  describe('the durable fake gateway', () => {
    it('lets the first call decide and replays it, decline included', async () => {
      const key = 'order-9-r1-e1'
      const request = {
        idempotencyKey: key,
        description: 'x',
        amountCents: 500,
      }

      const declined = await ctx.gateway.charge({
        ...request,
        simulateFailure: true,
      })
      const replay = await ctx.gateway.charge(request)
      const other = await new FakePaymentGateway(ctx.db).charge(request)
      const reused = await ctx.gateway.charge({ ...request, amountCents: 501 })

      expect(declined.status).toBe('failed')
      expect(replay).toEqual(declined)
      expect(other).toEqual(declined)
      expect(reused.failureMessage).toBe('IDEMPOTENCY_KEY_REUSED')
      expect(await ctx.gateway.lookup(key)).toEqual({
        status: 'declined',
        amountCents: 500,
        reference: null,
      })
      expect(await ctx.gateway.lookup('order-9-r1-e2')).toBeNull()
    })

    it('decides once across concurrent first calls', async () => {
      const request = {
        idempotencyKey: 'k-race',
        description: 'x',
        amountCents: 700,
      }

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          new FakePaymentGateway(ctx.db).charge({
            ...request,
            simulateFailure: i % 2 === 0,
          }),
        ),
      )

      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1)
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
      // A second, balanced paid order whose payment is past 2^53; no API path
      // can create it. Payments are append-only (revision 11b), so it is
      // written whole rather than by changing an existing payment. The amount
      // stays text so JavaScript never rounds it.
      const huge = '9007199254740993'
      await ctx.db.transaction(async (tx) => {
        const inserted = await tx.execute<{ id: number }>(sql`
          insert into orders (provider_id, patient_id, status, subtotal_cents,
            platform_fee_cents, total_cents, sent_at, paid_at, revision)
          select provider_id, patient_id, 'paid', ${huge}::bigint, 0,
            ${huge}::bigint, now(), now(), 1
          from orders where id = ${orderId}
          returning id`)
        const bigOrder = inserted.rows[0]!.id
        const payment = await tx.execute<{ id: number }>(sql`
          insert into payments (order_id, amount_cents, idempotency_key, gateway_reference)
          values (${bigOrder}, ${huge}::bigint, 'huge-order', 'ref-huge-order')
          returning id`)
        const paymentId = payment.rows[0]!.id
        await tx.execute(sql`
          insert into ledger_entries (order_id, payment_id, type, amount_cents) values
            (${bigOrder}, ${paymentId}, 'cogs', ${huge}::bigint),
            (${bigOrder}, ${paymentId}, 'provider_margin', 0),
            (${bigOrder}, ${paymentId}, 'platform_fee', 0)`)
      })

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
