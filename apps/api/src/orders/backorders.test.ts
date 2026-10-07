import {
  insufficientStockErrorResponseSchema,
  lowStockUnacknowledgedErrorResponseSchema,
  patientOrderDetailDtoSchema,
  providerOrderDetailDtoSchema,
  type PatientOrderDetailDto,
} from '@supplement-orders/domain'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ledgerEntries,
  orderItems,
  orders,
  ordersWithStatus,
  payments,
} from '../db/schema'
import { as, createDraft, createSentOrder, setStock } from '../testing/flows'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'

// Revision 14 (DOMAIN_CONTRACT 14.1-14.7, 14.3b): low stock on send, partial
// payment into back-orders, and the derived awaiting_stock status.

describe('revision 14: low stock, partial payment and back-orders', () => {
  let ctx: InternalTestContext

  beforeAll(async () => {
    ctx = await createInternalTestContext()
  })
  beforeEach(async () => {
    await ctx.reset()
  })
  afterAll(async () => {
    await ctx.close()
  })

  function product(index: number) {
    const p = ctx.seed.products[index]
    if (!p) throw new Error(`No seeded product ${index}`)
    return p
  }

  /** Three lines on the first three products, priced well above their minimums. */
  function threeLines(quantities: [number, number, number] = [4, 3, 2]) {
    return quantities.map((quantity, index) => ({
      productId: product(index).id,
      quantity,
      unitPriceCents: product(index).cogsCents + 500 + index,
    }))
  }

  async function patientDetail(orderId: number) {
    const res = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.patientUserId))
    expect(res.status).toBe(200)
    return patientOrderDetailDtoSchema.parse(res.body)
  }

  async function providerDetail(orderId: number) {
    const res = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.providerUserId))
    expect(res.status).toBe(200)
    return providerOrderDetailDtoSchema.parse(res.body)
  }

  function payBody(detail: PatientOrderDetailDto, mode: 'full' | 'available') {
    return {
      expectedRevision: detail.revision,
      expectedTotalCents:
        mode === 'full' ? detail.totalCents : detail.quote!.availableTotalCents,
      mode,
    }
  }

  async function payAvailable(orderId: number, overrides: object = {}) {
    const detail = await patientDetail(orderId)
    return ctx.request
      .post(`/api/orders/${orderId}/pay`)
      .set(as(ctx.seed.patientUserId))
      .send({ ...payBody(detail, 'available'), ...overrides })
  }

  async function effectiveStatus(orderIds: number[]) {
    const rows = await ctx.db
      .select({
        id: ordersWithStatus.id,
        status: ordersWithStatus.effectiveStatus,
      })
      .from(ordersWithStatus)
      .where(inArray(ordersWithStatus.id, orderIds))
      .orderBy(ordersWithStatus.id)
    return rows.map((r) => r.status)
  }

  async function backordersOf(orderId: number) {
    return ctx.db
      .select()
      .from(orders)
      .where(eq(orders.splitFromOrderId, orderId))
  }

  async function expectBalancedLedger() {
    const [paid, entries] = await Promise.all([
      ctx.db.select().from(payments),
      ctx.db.select().from(ledgerEntries),
    ])
    paid.forEach((payment) => {
      const own = entries.filter((e) => e.paymentId === payment.id)
      expect(own.map((e) => e.type).sort()).toEqual([
        'cogs',
        'platform_fee',
        'provider_margin',
      ])
      expect(own.every((e) => e.orderId === payment.orderId)).toBe(true)
      expect(own.reduce((sum, e) => sum + e.amountCents, 0)).toBe(
        payment.amountCents,
      )
    })
    return paid
  }

  describe('send (14.6)', () => {
    it('saves above stock, then needs an acknowledgement to send', async () => {
      const p = product(0)
      const orderId = await createDraft(ctx, [
        {
          productId: p.id,
          quantity: p.stockQuantity + 5,
          unitPriceCents: p.cogsCents + 500,
        },
      ])
      const draft = await providerDetail(orderId)
      expect(draft.lines[0]?.availableQuantity).toBe(p.stockQuantity)
      expect(draft.lines[0]?.lineId).toEqual(expect.any(Number))

      const refused = await ctx.request
        .post(`/api/orders/${orderId}/send`)
        .set(as(ctx.seed.providerUserId))
        .send({})
      expect(refused.status).toBe(409)
      const body = lowStockUnacknowledgedErrorResponseSchema.parse(refused.body)
      expect(body.error.lines).toEqual([
        {
          lineId: draft.lines[0]!.lineId,
          productId: p.id,
          productName: draft.lines[0]!.productName,
          quantity: p.stockQuantity + 5,
          availableQuantity: p.stockQuantity,
        },
      ])
      expect((await providerDetail(orderId)).status).toBe('draft')

      const sent = await ctx.request
        .post(`/api/orders/${orderId}/send`)
        .set(as(ctx.seed.providerUserId))
        .send({ acknowledgeLowStock: true })
      expect(sent.status).toBe(200)
      expect(sent.body.status).toBe('pending_payment')
      // Stock is not reserved at send.
      expect((await providerDetail(orderId)).lines[0]?.stockQuantity).toBe(
        p.stockQuantity,
      )
    })

    it('rejects a non-boolean acknowledgement', async () => {
      const orderId = await createDraft(ctx)
      const res = await ctx.request
        .post(`/api/orders/${orderId}/send`)
        .set(as(ctx.seed.providerUserId))
        .send({ acknowledgeLowStock: 'yes' })
      expect(res.status).toBe(400)
      expect(res.body.error.field).toBe('acknowledgeLowStock')
    })
  })

  describe('derived status (14.3, 14.3b)', () => {
    it('reads awaiting_stock in detail, lists, filters and the patient latest status', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await Promise.all([0, 1, 2].map((i) => setStock(ctx, product(i).id, 0)))

      expect((await providerDetail(orderId)).status).toBe('awaiting_stock')
      const patientView = await patientDetail(orderId)
      expect(patientView.status).toBe('awaiting_stock')
      expect(patientView.quote).toMatchObject({
        payable: false,
        hasShortfall: true,
        availableTotalCents: 0,
      })

      const provider = as(ctx.seed.providerUserId)
      const awaiting = await ctx.request
        .get('/api/orders?status=awaiting_stock')
        .set(provider)
      expect(awaiting.body.items.map((o: { id: number }) => o.id)).toEqual([
        orderId,
      ])
      expect(awaiting.body.items[0].status).toBe('awaiting_stock')
      const pending = await ctx.request
        .get('/api/orders?status=pending_payment')
        .set(provider)
      expect(pending.body.total).toBe(0)
      const both = await ctx.request
        .get('/api/orders?status=pending_payment,awaiting_stock')
        .set(provider)
      expect(both.body.total).toBe(1)

      const summaries = await ctx.request.get('/api/orders').set(provider)
      expect(summaries.body[0].status).toBe('awaiting_stock')
      const mine = await ctx.request
        .get('/api/orders')
        .set(as(ctx.seed.patientUserId))
      expect(mine.body[0].status).toBe('awaiting_stock')

      const patients = await ctx.request
        .get('/api/patients?latestStatus=awaiting_stock')
        .set(provider)
      expect(patients.body.items.map((p: { id: number }) => p.id)).toEqual([
        ctx.seed.patientId,
      ])
      expect(patients.body.items[0].latestOrderStatus).toBe('awaiting_stock')
    })

    it('reflects admin and payment stock changes immediately for every open order with the product', async () => {
      const p = product(0)
      const line = {
        productId: p.id,
        quantity: 1,
        unitPriceCents: p.cogsCents + 500,
      }
      const ids = [
        await createSentOrder(ctx, [line]),
        await createSentOrder(ctx, [line]),
        await createSentOrder(ctx, [line]),
      ]
      const admin = as(ctx.seed.adminUserId)
      const set = await ctx.request
        .put(`/api/admin/products/${p.id}/stock`)
        .set(admin)
        .send({ stockQuantity: 0, expectedStockQuantity: p.stockQuantity })
      expect(set.status).toBe(200)
      expect(await effectiveStatus(ids)).toEqual([
        'awaiting_stock',
        'awaiting_stock',
        'awaiting_stock',
      ])

      const incremented = await ctx.request
        .post(`/api/admin/products/${p.id}/stock/increment`)
        .set(admin)
        .send({ by: 1 })
      expect(incremented.status).toBe(200)
      expect(await effectiveStatus(ids)).toEqual([
        'pending_payment',
        'pending_payment',
        'pending_payment',
      ])

      // Paying the first takes the last unit: the other two await stock.
      const firstDetail = await patientDetail(ids[0]!)
      const paid = await ctx.request
        .post(`/api/orders/${ids[0]}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send(payBody(firstDetail, 'full'))
      expect(paid.status).toBe(200)
      expect(await effectiveStatus(ids)).toEqual([
        'paid',
        'awaiting_stock',
        'awaiting_stock',
      ])
    })
  })

  describe('pay (14.5)', () => {
    it('full mode with a shortfall is 409 INSUFFICIENT_STOCK and charges nothing', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(1).id, 1)
      const detail = await patientDetail(orderId)

      const res = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send(payBody(detail, 'full'))

      expect(res.status).toBe(409)
      const body = insufficientStockErrorResponseSchema.parse(res.body)
      expect(body.error.availability).toEqual(
        detail.lines.map((l) => ({
          lineId: l.lineId,
          productId: l.productId,
          quantity: l.quantity,
          availableQuantity:
            l.productId === product(1).id ? 1 : l.availableQuantity,
        })),
      )
      expect(body.error.quote).toEqual(detail.quote)
      expect(ctx.gateway.charges).toHaveLength(0)
      expect(await backordersOf(orderId)).toEqual([])
    })

    it('available mode charges the in-stock portion and moves the shortfall to one back-order', async () => {
      // Mixed: line 0 has none, line 1 partial (1 of 3), line 2 fully in stock.
      const lines = threeLines([4, 3, 2])
      const orderId = await createSentOrder(ctx, lines)
      await setStock(ctx, product(0).id, 0)
      await setStock(ctx, product(1).id, 1)
      const before = await patientDetail(orderId)
      const quote = before.quote!
      expect(quote).toMatchObject({ payable: true, hasShortfall: true })

      const res = await payAvailable(orderId)

      expect(res.status).toBe(200)
      const paid = patientOrderDetailDtoSchema.parse(res.body)
      expect(paid.status).toBe('paid')
      expect(paid.revision).toBe(before.revision + 1)
      expect(paid.totalCents).toBe(quote.availableTotalCents)
      expect(paid.payment?.amountCents).toBe(quote.availableTotalCents)
      expect(paid.lines.map((l) => [l.productId, l.quantity])).toEqual([
        [product(1).id, 1],
        [product(2).id, 2],
      ])
      expect(paid.backorderOrderId).toEqual(expect.any(Number))
      expect(paid.splitFromOrderId).toBeNull()
      expect(ctx.gateway.charges).toHaveLength(1)
      expect(ctx.gateway.charges[0]?.amountCents).toBe(
        quote.availableTotalCents,
      )

      const backorder = await patientDetail(paid.backorderOrderId!)
      expect(backorder.splitFromOrderId).toBe(orderId)
      expect(backorder.backorderOrderId).toBeNull()
      expect(backorder.revision).toBe(1)
      expect(backorder.status).toBe('awaiting_stock')
      expect(backorder.totalCents).toBe(quote.backorderTotalCents)
      expect(
        backorder.lines.map((l) => [l.productId, l.quantity, l.unitPriceCents]),
      ).toEqual([
        [product(0).id, 4, lines[0]!.unitPriceCents],
        [product(1).id, 2, lines[1]!.unitPriceCents],
      ])
      const [row] = await backordersOf(orderId)
      expect(row?.splitFromRevision).toBe(before.revision)
      const providerBackorder = await providerDetail(backorder.id)
      expect(providerBackorder.lines.map((l) => l.unitCogsCents)).toEqual([
        product(0).cogsCents,
        product(1).cogsCents,
      ])

      // Stock was taken only for the paid units.
      const original = await providerDetail(orderId)
      expect(original.lines.map((l) => l.stockQuantity)).toEqual([
        0,
        product(2).stockQuantity - 2,
      ])
      await expectBalancedLedger()
    })

    it('available mode without a shortfall is an ordinary full payment', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      const res = await payAvailable(orderId)
      expect(res.status).toBe(200)
      expect(res.body.backorderOrderId).toBeNull()
      expect(res.body.revision).toBe(1)
    })

    it('a stale available quote is 409 ORDER_CHANGED with the fresh quote and no split', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(0).id, 2)
      const seen = await patientDetail(orderId)
      await setStock(ctx, product(0).id, 1)

      const res = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send(payBody(seen, 'available'))

      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('ORDER_CHANGED')
      expect(res.body.error.quote).toEqual((await patientDetail(orderId)).quote)
      expect(res.body.error.quote.availableTotalCents).not.toBe(
        seen.quote!.availableTotalCents,
      )
      expect(await backordersOf(orderId)).toEqual([])
      expect(ctx.gateway.charges).toHaveLength(0)

      expect((await payAvailable(orderId)).status).toBe(200)
    })

    it('nothing payable is 409 AWAITING_STOCK', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await Promise.all([0, 1, 2].map((i) => setStock(ctx, product(i).id, 0)))
      const res = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send({ expectedRevision: 1, expectedTotalCents: 0, mode: 'available' })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('AWAITING_STOCK')
      expect(ctx.gateway.charges).toHaveLength(0)
    })

    it('a retried split, also after a restart, splits once and charges once', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(0).id, 1)
      const seen = await patientDetail(orderId)
      const body = payBody(seen, 'available')
      const send = () =>
        ctx.request
          .post(`/api/orders/${orderId}/pay`)
          .set(as(ctx.seed.patientUserId))
          .send(body)

      const first = await send()
      expect(first.status).toBe(200)
      const again = await send()
      expect(again.status).toBe(200)
      ctx.restart()
      const afterRestart = await send()
      expect(afterRestart.status).toBe(200)

      expect(afterRestart.body.backorderOrderId).toBe(
        first.body.backorderOrderId,
      )
      expect(await backordersOf(orderId)).toHaveLength(1)
      const paid = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.orderId, orderId))
      expect(paid).toHaveLength(1)
    })

    it('a retry after a decline that followed the split pays the reduced order', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(0).id, 1)
      const seen = await patientDetail(orderId)
      const declined = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.patientUserId))
        .send({ ...payBody(seen, 'available'), simulateFailure: true })
      expect(declined.status).toBe(402)
      expect(await backordersOf(orderId)).toHaveLength(1)

      const retried = await payAvailable(orderId)
      expect(retried.status).toBe(200)
      expect(retried.body.totalCents).toBe(seen.quote!.availableTotalCents)
      expect(await backordersOf(orderId)).toHaveLength(1)
    })

    it('two concurrent available pays create one split and one charge', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(2).id, 0)
      const body = payBody(await patientDetail(orderId), 'available')
      const results = await Promise.all(
        [0, 1].map(() =>
          ctx.request
            .post(`/api/orders/${orderId}/pay`)
            .set(as(ctx.seed.patientUserId))
            .send(body),
        ),
      )
      expect(results.map((r) => r.status)).toEqual([200, 200])
      expect(await backordersOf(orderId)).toHaveLength(1)
      const keys = new Set(ctx.gateway.charges.map((c) => c.idempotencyKey))
      expect(keys.size).toBe(1)
      await expectBalancedLedger()
    })

    it('a back-order can be partially paid into the next link of the chain', async () => {
      const orderId = await createSentOrder(ctx, threeLines([4, 3, 2]))
      await setStock(ctx, product(0).id, 0)
      await setStock(ctx, product(1).id, 0)
      const first = await payAvailable(orderId)
      const secondId: number = first.body.backorderOrderId

      await setStock(ctx, product(0).id, 1)
      const second = await payAvailable(secondId)
      expect(second.status).toBe(200)
      const thirdId: number = second.body.backorderOrderId
      expect(thirdId).toEqual(expect.any(Number))

      const third = await patientDetail(thirdId)
      expect(third.splitFromOrderId).toBe(secondId)
      expect((await patientDetail(secondId)).splitFromOrderId).toBe(orderId)
      expect(third.lines.map((l) => [l.productId, l.quantity])).toEqual([
        [product(0).id, 3],
        [product(1).id, 3],
      ])
      await expectBalancedLedger()
    })

    it('only the order’s patient can pay it', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(0).id, 1)
      const body = payBody(await patientDetail(orderId), 'available')
      const other = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.otherPatientUserId))
        .send(body)
      const provider = await ctx.request
        .post(`/api/orders/${orderId}/pay`)
        .set(as(ctx.seed.providerUserId))
        .send(body)
      expect([other.status, provider.status]).toEqual([403, 403])
      expect(await backordersOf(orderId)).toEqual([])
    })
  })

  describe('back-order lifecycle (14.7)', () => {
    it('blocks reopen, allows cancel, and blocks reopen after cancel', async () => {
      const orderId = await createSentOrder(ctx, threeLines())
      await setStock(ctx, product(0).id, 0)
      const paid = await payAvailable(orderId)
      const backorderId: number = paid.body.backorderOrderId
      const provider = as(ctx.seed.providerUserId)

      const reopen = await ctx.request
        .post(`/api/orders/${backorderId}/reopen`)
        .set(provider)
      expect([reopen.status, reopen.body.error.code]).toEqual([
        409,
        'BACKORDER_NOT_EDITABLE',
      ])
      const edit = await ctx.request
        .put(`/api/orders/${backorderId}/lines`)
        .set(provider)
        .send({ lines: [] })
      expect(edit.status).toBe(409)

      const cancelled = await ctx.request
        .post(`/api/orders/${backorderId}/cancel`)
        .set(provider)
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.status).toBe('cancelled')
      expect(cancelled.body.splitFromOrderId).toBe(orderId)

      const reopenAfter = await ctx.request
        .post(`/api/orders/${backorderId}/reopen`)
        .set(provider)
      expect(reopenAfter.body.error.code).toBe('BACKORDER_NOT_EDITABLE')
      const items = await ctx.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, backorderId))
      expect(items).toHaveLength(1)
    })
  })
})
