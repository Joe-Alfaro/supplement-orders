import {
  adminPaymentAttemptListDtoSchema,
  dashboardDtoSchema,
  expectedPayableLinesOf,
  patientOrderDetailDtoSchema,
  paymentPendingErrorResponseSchema,
  providerOrderDetailDtoSchema,
  reconcilePaymentAttemptDtoSchema,
  type PatientOrderDetailDto,
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
  inventoryAdjustments,
  orderItems,
  orders,
  paymentAttempts,
  payments,
  products,
} from '../db/schema'
import { as, createDraft, createSentOrder, setStock } from '../testing/flows'
import {
  attemptKey,
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 18 (audit 6): live back-orders and reopen merging (18.1), stranded
// payments and admin reconcile (18.2), sold by product (18.3), and the lows
// the API owns (18.4: L4 keys, L5 fees, L6 404s, L7 frozen attempts, L8 lines).

describe('revision 18', () => {
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

  const product = (i: number) => ctx.seed.products[i]!
  const provider = () => as(ctx.seed.providerUserId)
  const patient = () => as(ctx.seed.patientUserId)
  const admin = () => as(ctx.seed.adminUserId)

  async function patientDetail(id: number) {
    const res = await ctx.request.get(`/api/orders/${id}`).set(patient())
    expect(res.status).toBe(200)
    return patientOrderDetailDtoSchema.parse(res.body)
  }

  async function providerDetail(id: number) {
    const res = await ctx.request.get(`/api/orders/${id}`).set(provider())
    expect(res.status).toBe(200)
    return providerOrderDetailDtoSchema.parse(res.body)
  }

  /** Sends back exactly the quote the patient sees: partial when short, else full. */
  function payQuote(
    id: number,
    seen: PatientOrderDetailDto,
    extra: object = {},
  ) {
    const quote = seen.partialPaymentQuote!
    const body = quote.hasShortfall
      ? {
          mode: 'available',
          expectedRevision: seen.revision,
          expectedTotalCents: quote.pay.totalCents,
          expectedPayableLines: expectedPayableLinesOf(seen.lines),
        }
      : { expectedRevision: seen.revision, expectedTotalCents: seen.totalCents }
    return ctx.request
      .post(`/api/orders/${id}/pay`)
      .set(patient())
      .send({ ...body, ...extra })
  }

  async function childrenOf(id: number) {
    return ctx.db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.splitFromOrderId, id))
      .orderBy(asc(orders.id))
  }

  async function stockOf(productId: number) {
    const [row] = await ctx.db
      .select({ stock: products.stockQuantity })
      .from(products)
      .where(eq(products.id, productId))
    return row!.stock
  }

  function linesOf(detail: { lines: { productId: number | null }[] }) {
    return detail.lines.map((l) => {
      const { productId, quantity, unitPriceCents } = l as {
        productId: number
        quantity: number
        unitPriceCents: number
      }
      return { productId, quantity, unitPriceCents }
    })
  }

  /** A, short; B, in stock. Pays the in-stock part, declined, so it splits. */
  async function splitThenDecline() {
    const a = product(0)
    const b = product(1)
    const original = [
      { productId: a.id, quantity: 3, unitPriceCents: a.cogsCents + 500 },
      { productId: b.id, quantity: 1, unitPriceCents: b.cogsCents + 300 },
    ]
    const id = await createSentOrder(ctx, original)
    await setStock(ctx, a.id, 1)
    const declined = await payQuote(id, await patientDetail(id), {
      simulateFailure: true,
    })
    expect(declined.status).toBe(402)
    const [backorder] = await childrenOf(id)
    expect(backorder?.status).toBe('pending_payment')
    return { id, backorderId: backorder!.id, a, b, original }
  }

  describe('18.1 partial payment never dead-ends', () => {
    it("ends the auditor's R2 sequence in a 200 with one new live back-order", async () => {
      const { id, backorderId, a, original } = await splitThenDecline()

      expect(
        (await ctx.request.post(`/api/orders/${id}/cancel`).set(provider()))
          .status,
      ).toBe(200)
      expect(
        (await ctx.request.post(`/api/orders/${id}/reopen`).set(provider()))
          .status,
      ).toBe(200)
      const reopened = await providerDetail(id)
      expect(reopened.status).toBe('draft')
      expect(linesOf(reopened)).toEqual(original)

      const sent = await ctx.request
        .post(`/api/orders/${id}/send`)
        .set(provider())
        .send({ acknowledgeLowStock: true })
      expect(sent.status).toBe(200)
      const paid = await payQuote(id, await patientDetail(id))
      expect(paid.status).toBe(200)

      const children = await childrenOf(id)
      expect(children).toEqual([
        { id: backorderId, status: 'cancelled' },
        { id: expect.any(Number), status: 'pending_payment' },
      ])
      const live = children[1]!
      expect(paid.body.backorderOrderId).toBe(live.id)
      const liveDetail = await providerDetail(live.id)
      expect(linesOf(liveDetail)).toEqual([
        { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
      ])
    })

    it('merges a cancelled back-order back only once', async () => {
      const { id, original } = await splitThenDecline()
      await ctx.request.post(`/api/orders/${id}/cancel`).set(provider())
      await ctx.request.post(`/api/orders/${id}/reopen`).set(provider())
      await ctx.request
        .post(`/api/orders/${id}/send`)
        .set(provider())
        .send({ acknowledgeLowStock: true })
      await ctx.request.post(`/api/orders/${id}/cancel`).set(provider())
      await ctx.request.post(`/api/orders/${id}/reopen`).set(provider())

      expect(linesOf(await providerDetail(id))).toEqual(original)
    })

    it('adds a merged product as a new line at its back-order price', async () => {
      const a = product(0)
      const b = product(1)
      const id = await createSentOrder(ctx, [
        { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
        { productId: b.id, quantity: 1, unitPriceCents: b.cogsCents + 300 },
      ])
      // A is out of stock, so the split moves its whole line to the back-order.
      await setStock(ctx, a.id, 0)
      const declined = await payQuote(id, await patientDetail(id), {
        simulateFailure: true,
      })
      expect(declined.status).toBe(402)
      expect(linesOf(await providerDetail(id))).toEqual([
        { productId: b.id, quantity: 1, unitPriceCents: b.cogsCents + 300 },
      ])

      await ctx.request.post(`/api/orders/${id}/cancel`).set(provider())
      await ctx.request.post(`/api/orders/${id}/reopen`).set(provider())
      expect(linesOf(await providerDetail(id))).toEqual([
        { productId: b.id, quantity: 1, unitPriceCents: b.cogsCents + 300 },
        { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
      ])
    })

    it('quotes awaiting_restock when a reduced order is short again, and every offered quote round-trips', async () => {
      const { id, b } = await splitThenDecline()
      // Now B is short on the reduced order, which already has a live back-order.
      await setStock(ctx, b.id, 0)
      const short = await patientDetail(id)
      expect(short.partialPaymentQuote).toMatchObject({
        payable: false,
        hasShortfall: true,
        reason: 'awaiting_restock',
      })
      expect(short.backorderOrderId).not.toBeNull()

      await setStock(ctx, b.id, 5)
      const restocked = await patientDetail(id)
      expect(restocked.partialPaymentQuote).toMatchObject({
        payable: true,
        hasShortfall: false,
      })
      expect(restocked.partialPaymentQuote).not.toHaveProperty('reason')
      expect((await payQuote(id, restocked)).status).toBe(200)
    })

    it('round-trips every payable quote, with and without a live back-order', async () => {
      const a = product(0)
      const b = product(1)
      const lines = [
        { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
        { productId: b.id, quantity: 2, unitPriceCents: b.cogsCents + 300 },
      ]
      const cases: [number, number][] = [
        [5, 5],
        [1, 5],
        [1, 1],
      ]
      await cases.reduce(async (prev, [stockA, stockB]) => {
        await prev
        await setStock(ctx, a.id, 10)
        await setStock(ctx, b.id, 10)
        const id = await createSentOrder(ctx, lines)
        await setStock(ctx, a.id, stockA)
        await setStock(ctx, b.id, stockB)
        const seen = await patientDetail(id)
        expect(seen.partialPaymentQuote?.payable).toBe(true)
        expect((await payQuote(id, seen)).status).toBe(200)
      }, Promise.resolve())
    })

    it('enforces one live back-order per order in the database', async () => {
      const { id, backorderId } = await splitThenDecline()
      const duplicate = ctx.db.execute(sql`
        insert into orders (provider_id, patient_id, status, subtotal_cents, platform_fee_cents, total_cents, sent_at, revision, split_from_order_id, split_from_revision)
        select provider_id, patient_id, 'pending_payment', 100, 1, 100, now(), 1, ${id}, 9
          from orders where id = ${backorderId}`)
      await expect(duplicate).rejects.toThrow()
    })
  })

  describe('18.2 stranded payments', () => {
    async function pendingAfterThrow(
      behaviour: 'before' | 'after-success' | 'after-decline',
    ) {
      const a = product(0)
      const id = await createSentOrder(ctx, [
        { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
      ])
      const stockBefore = await stockOf(a.id)
      const real = ctx.gateway.charge.bind(ctx.gateway)
      vi.spyOn(ctx.gateway, 'charge').mockImplementationOnce(
        async (request, options) => {
          if (behaviour === 'after-success') await real(request, options)
          if (behaviour === 'after-decline') {
            await real({ ...request, simulateFailure: true }, options)
          }
          throw new Error('ETIMEDOUT')
        },
      )
      const seen = await patientDetail(id)
      const res = await payQuote(id, seen)
      expect(res.status).toBe(503)
      const body = paymentPendingErrorResponseSchema.parse(res.body)
      expect(body.error).toMatchObject({
        code: 'PAYMENT_PENDING',
        orderId: id,
        revision: seen.revision,
        amountCents: seen.totalCents,
      })
      const [attempt] = await ctx.db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, id))
      expect(attempt).toMatchObject({ status: 'pending', stockHeld: true })
      expect(await stockOf(a.id)).toBe(stockBefore - 2)
      return { id, attemptId: attempt!.id, productId: a.id, stockBefore }
    }

    function reconcile(attemptId: number, user = admin()) {
      return ctx.request
        .post(`/api/admin/payment-attempts/${attemptId}/reconcile`)
        .set(user)
    }

    async function unresolvedIds() {
      const res = await ctx.request
        .get('/api/admin/payment-attempts?status=unresolved')
        .set(admin())
      expect(res.status).toBe(200)
      return adminPaymentAttemptListDtoSchema
        .parse(res.body)
        .map((item) => item.id)
    }

    it('lists the stranded attempt without patient data', async () => {
      const { id, attemptId } = await pendingAfterThrow('before')
      const res = await ctx.request
        .get('/api/admin/payment-attempts')
        .set(admin())
      expect(res.status).toBe(200)
      const items = adminPaymentAttemptListDtoSchema.parse(res.body)
      expect(items).toEqual([
        expect.objectContaining({
          id: attemptId,
          orderId: id,
          status: 'pending',
          hasPayment: false,
          reconciledAt: null,
        }),
      ])
      const text = JSON.stringify(res.body).toLowerCase()
      expect(text).not.toContain('patient')
      expect(Object.keys(items[0]!).sort()).toEqual([
        'ageSeconds',
        'amountCents',
        'createdAt',
        'hasPayment',
        'id',
        'orderId',
        'providerName',
        'reconciledAt',
        'status',
      ])
    })

    it('finalizes a charge the gateway took, with one payment and one charge', async () => {
      const { id, attemptId } = await pendingAfterThrow('after-success')
      const charges = ctx.gateway.charges.length
      const res = await reconcile(attemptId)
      expect(res.status).toBe(200)
      const body = reconcilePaymentAttemptDtoSchema.parse(res.body)
      expect(body.outcome).toBe('finalized')
      expect(body.attempt).toMatchObject({
        status: 'succeeded',
        hasPayment: true,
      })
      expect(body.attempt.reconciledAt).not.toBeNull()
      expect(ctx.gateway.charges.length).toBe(charges)
      expect(
        await ctx.db.select().from(payments).where(eq(payments.orderId, id)),
      ).toHaveLength(1)
      expect(await ctx.db.select().from(fakeGatewayCharges)).toHaveLength(1)
      expect((await patientDetail(id)).status).toBe('paid')
      expect(await unresolvedIds()).toEqual([])

      const again = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attemptId)).body,
      )
      expect(again.outcome).toBe('unchanged')
    })

    it('declines and releases stock once, with an audit row per product', async () => {
      const { attemptId, productId, stockBefore } =
        await pendingAfterThrow('after-decline')
      const first = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attemptId)).body,
      )
      expect(first.outcome).toBe('declined')
      expect(await stockOf(productId)).toBe(stockBefore)
      const second = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attemptId)).body,
      )
      expect(second.outcome).toBe('unchanged')
      expect(await stockOf(productId)).toBe(stockBefore)
      expect(
        await ctx.db
          .select({
            kind: inventoryAdjustments.kind,
            previousQuantity: inventoryAdjustments.previousQuantity,
            newQuantity: inventoryAdjustments.newQuantity,
            paymentAttemptId: inventoryAdjustments.paymentAttemptId,
          })
          .from(inventoryAdjustments),
      ).toEqual([
        {
          kind: 'reconcile_release',
          previousQuantity: stockBefore - 2,
          newQuantity: stockBefore,
          paymentAttemptId: attemptId,
        },
      ])
    })

    it('is too early before 15 minutes, then abandons and releases on the injected clock', async () => {
      const { id, attemptId, productId, stockBefore } =
        await pendingAfterThrow('before')
      const early = await reconcile(attemptId)
      expect(early.status).toBe(409)
      expect(early.body.error.code).toBe('RECONCILE_TOO_EARLY')
      expect(await stockOf(productId)).toBe(stockBefore - 2)

      ctx.clock!.now = new Date(Date.now() + 15 * 60 * 1000 + 1000)
      const late = reconcilePaymentAttemptDtoSchema.parse(
        (await reconcile(attemptId)).body,
      )
      expect(late.outcome).toBe('abandoned')
      expect(late.attempt.status).toBe('abandoned')
      expect(await stockOf(productId)).toBe(stockBefore)
      expect(
        reconcilePaymentAttemptDtoSchema.parse(
          (await reconcile(attemptId)).body,
        ).outcome,
      ).toBe('unchanged')
      expect(await stockOf(productId)).toBe(stockBefore)

      // The order is unblocked: the patient pays with a new execution.
      const paid = await payQuote(id, await patientDetail(id))
      expect(paid.status).toBe(200)
      const keys = (
        await ctx.db
          .select({ key: paymentAttempts.idempotencyKey })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.orderId, id))
          .orderBy(asc(paymentAttempts.id))
      ).map((r) => r.key)
      expect(keys).toEqual([
        attemptKey(ctx, id, paid.body.revision, 1),
        attemptKey(ctx, id, paid.body.revision, 2),
      ])
    })

    it('refuses providers, patients and unknown attempts', async () => {
      const { attemptId } = await pendingAfterThrow('before')
      expect((await reconcile(attemptId, provider())).status).toBe(403)
      expect((await reconcile(attemptId, patient())).status).toBe(403)
      expect(
        (await ctx.request.get('/api/admin/payment-attempts').set(provider()))
          .status,
      ).toBe(403)
      expect((await reconcile(999_999)).status).toBe(404)
    })
  })

  describe('18.3 sold by product', () => {
    it('reports units and revenue per product from paid orders, by revenue', async () => {
      const a = product(0)
      const b = product(1)
      const lines = [
        { productId: a.id, quantity: 2, unitPriceCents: a.cogsCents + 500 },
        { productId: b.id, quantity: 1, unitPriceCents: b.cogsCents + 300 },
      ]
      const paidId = await createSentOrder(ctx, lines)
      expect((await payQuote(paidId, await patientDetail(paidId))).status).toBe(
        200,
      )
      await createSentOrder(ctx, lines)

      const res = await ctx.request
        .get('/api/dashboard?range=all')
        .set(provider())
      const dashboard = dashboardDtoSchema.parse(res.body)
      const expected = [
        {
          productId: a.id,
          unitsSold: 2,
          revenueCents: 2 * (a.cogsCents + 500),
        },
        {
          productId: b.id,
          unitsSold: 1,
          revenueCents: b.cogsCents + 300,
        },
      ].sort((x, y) => y.revenueCents - x.revenueCents)
      expect(dashboard.soldByProduct).toEqual(
        expected.map((row) => expect.objectContaining(row)),
      )
      const other = await ctx.request
        .get('/api/dashboard?range=all')
        .set(as(ctx.seed.otherProviderUserId))
      expect(dashboardDtoSchema.parse(other.body).soldByProduct).toEqual([])
    })
  })

  describe('18.4 lows', () => {
    it('L4: prefixes keys with the installation id', async () => {
      const id = await createSentOrder(ctx)
      const res = await payQuote(id, await patientDetail(id))
      expect(res.status).toBe(200)
      const [attempt] = await ctx.db
        .select({ key: paymentAttempts.idempotencyKey })
        .from(paymentAttempts)
      expect(attempt!.key).toBe(attemptKey(ctx, id, res.body.revision))
      expect(ctx.installId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it("L5: conserves the auditor's R5 fee of 17 cents across the chain", async () => {
      const a = product(0)
      const id = await createSentOrder(ctx, [
        { productId: a.id, quantity: 2, unitPriceCents: 1100 },
      ])
      expect((await providerDetail(id)).split?.platformFeeCents).toBe(17)
      await setStock(ctx, a.id, 1)
      expect((await payQuote(id, await patientDetail(id))).status).toBe(200)
      const [backorder] = await childrenOf(id)
      await setStock(ctx, a.id, 5)
      expect(
        (await payQuote(backorder!.id, await patientDetail(backorder!.id)))
          .status,
      ).toBe(200)
      const fees = await Promise.all(
        [id, backorder!.id].map(
          async (orderId) => (await providerDetail(orderId)).split!,
        ),
      )
      expect(fees.map((f) => f.platformFeeCents)).toEqual([9, 8])
      fees.forEach((f) =>
        expect(f.providerMarginCents).toBeGreaterThanOrEqual(0),
      )
    })

    it('L6: another practice probing a patient or order gets 404', async () => {
      const id = await createSentOrder(ctx)
      const other = as(ctx.seed.otherProviderUserId)
      const results = await Promise.all([
        ctx.request.get(`/api/orders/${id}`).set(other),
        ctx.request.get(`/api/patients/${ctx.seed.patientId}`).set(other),
        ctx.request.post(`/api/orders/${id}/cancel`).set(other),
        ctx.request
          .post('/api/orders')
          .set(other)
          .send({ patientId: ctx.seed.patientId }),
      ])
      expect(results.map((r) => [r.status, r.body.error?.code])).toEqual(
        Array(4).fill([404, 'NOT_FOUND']),
      )
    })

    it('L7: freezes an attempt a payment references', async () => {
      const id = await createSentOrder(ctx)
      expect((await payQuote(id, await patientDetail(id))).status).toBe(200)
      await expect(
        ctx.db.execute(
          sql`update payment_attempts set amount_cents = amount_cents + 1 where order_id = ${id}`,
        ),
      ).rejects.toThrow()
      await expect(
        ctx.db.execute(
          sql`delete from payment_attempts where order_id = ${id}`,
        ),
      ).rejects.toThrow()
      await expect(
        ctx.db.execute(
          sql`update payment_attempts set updated_at = now() where order_id = ${id}`,
        ),
      ).rejects.toThrow()
    })

    it('L8: refuses more than 100 lines', async () => {
      const id = await createDraft(ctx, [])
      const lines = Array.from({ length: 101 }, () => ({
        productId: null,
        quantity: 1,
        unitPriceCents: null,
      }))
      const res = await ctx.request
        .put(`/api/orders/${id}/lines`)
        .set(provider())
        .send({ lines })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        field: 'lines',
      })
      expect(
        await ctx.db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, id)),
      ).toEqual([])
    })
  })
})
