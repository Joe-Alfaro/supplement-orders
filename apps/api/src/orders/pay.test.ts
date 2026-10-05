import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  as,
  createSentOrder,
  moneyState,
  pay,
  sampleLines,
  setStock,
} from '../testing/flows'

describe('POST /api/orders/:id/pay', () => {
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

  it('charges the total once and writes exactly three ledger rows summing to it', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)

    const res = await pay(ctx, orderId)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('paid')
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toHaveLength(1)
    const [payment] = after.payments
    expect(payment!.amountCents).toBe(res.body.totalCents)
    expect(payment!.idempotencyKey).toBe(`order-${orderId}-payment`)
    expect(after.ledger.map((e) => e.type).sort()).toEqual([
      'cogs',
      'platform_fee',
      'provider_margin',
    ])
    expect(after.ledger.every((e) => e.paymentId === payment!.id)).toBe(true)
    expect(after.ledger.reduce((sum, e) => sum + e.amountCents, 0)).toBe(
      payment!.amountCents,
    )
    expect(ctx.gateway.charges).toHaveLength(1)
    expect(ctx.gateway.charges[0]!.amountCents).toBe(payment!.amountCents)

    const [a, b] = sampleLines(ctx)
    const stockOf = (s: typeof before.stock, id: number) =>
      s.find((p) => p.id === id)!.stockQuantity
    expect(stockOf(after.stock, a!.productId)).toBe(
      stockOf(before.stock, a!.productId) - a!.quantity,
    )
    expect(stockOf(after.stock, b!.productId)).toBe(
      stockOf(before.stock, b!.productId) - b!.quantity,
    )
  })

  it('matches the split shown to the provider, to the cent', async () => {
    const orderId = await createSentOrder(ctx)
    await pay(ctx, orderId)

    const detail = await ctx.request
      .get(`/api/orders/${orderId}`)
      .set(as(ctx.seed.providerUserId))

    const byType = Object.fromEntries(
      detail.body.ledger.map((e: { type: string; amountCents: number }) => [
        e.type,
        e.amountCents,
      ]),
    )
    expect(byType).toEqual({
      cogs: detail.body.split.cogsCents,
      provider_margin: detail.body.split.providerMarginCents,
      platform_fee: detail.body.split.platformFeeCents,
    })
    expect(detail.body.payment.amountCents).toBe(detail.body.split.totalCents)
    // Revision 2: the fee comes out of the margin; the patient pays the subtotal.
    const subtotal = sampleLines(ctx).reduce(
      (sum, l) => sum + l.quantity * l.unitPriceCents,
      0,
    )
    expect(detail.body.payment.amountCents).toBe(subtotal)
    expect(detail.body.split.subtotalCents).toBe(subtotal)
    // Line stock is live, so it already reflects this order's decrement.
    const lineStock = detail.body.lines.map(
      (l: { stockQuantity: number }) => l.stockQuantity,
    )
    expect(lineStock).toEqual(
      sampleLines(ctx).map((l) => {
        const seeded = ctx.seed.products.find((p) => p.id === l.productId)
        return seeded!.stockQuantity - l.quantity
      }),
    )
  })

  it('rolls back everything when the gateway declines', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)

    const res = await pay(ctx, orderId, { simulateFailure: true })

    expect(res.status).toBe(402)
    expect(res.body.error.code).toBe('PAYMENT_FAILED')
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toHaveLength(0)
    expect(after.ledger).toHaveLength(0)
    expect(after.stock).toEqual(before.stock)
    expect(after.order).toEqual({ status: 'pending_payment', paidAt: null })

    // The order stays payable.
    expect((await pay(ctx, orderId)).status).toBe(200)
  })

  it('rolls back the payment, ledger and stock when a failure follows the ledger insert', async () => {
    const orderId = await createSentOrder(ctx)
    const before = await moneyState(ctx, orderId)
    ctx.payHooks.afterLedgerInsert = async () => {
      throw new Error('boom after ledger insert')
    }

    const res = await pay(ctx, orderId)

    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('INTERNAL')
    const after = await moneyState(ctx, orderId)
    expect(after.payments).toHaveLength(0)
    expect(after.ledger).toHaveLength(0)
    expect(after.stock).toEqual(before.stock)
    expect(after.order).toEqual({ status: 'pending_payment', paidAt: null })

    // A retry reuses the idempotency key, so the gateway returns the original charge.
    delete ctx.payHooks.afterLedgerInsert
    const retry = await pay(ctx, orderId)
    expect(retry.status).toBe(200)
    const keys = new Set(ctx.gateway.charges.map((c) => c.idempotencyKey))
    expect(keys.size).toBe(1)
  })

  it('is idempotent: paying a paid order neither charges nor writes again', async () => {
    const orderId = await createSentOrder(ctx)
    const first = await pay(ctx, orderId)
    const afterFirst = await moneyState(ctx, orderId)

    const second = await pay(ctx, orderId)

    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(await moneyState(ctx, orderId)).toEqual(afterFirst)
    expect(ctx.gateway.charges).toHaveLength(1)
  })

  it('serializes concurrent pays into a single charge', async () => {
    const orderId = await createSentOrder(ctx)

    const results = await Promise.all([pay(ctx, orderId), pay(ctx, orderId)])

    expect(results.map((r) => r.status)).toEqual([200, 200])
    const state = await moneyState(ctx, orderId)
    expect(state.payments).toHaveLength(1)
    expect(state.ledger).toHaveLength(3)
    expect(ctx.gateway.charges).toHaveLength(1)
  })

  it('refuses to charge when stock ran out after sending, and changes nothing', async () => {
    const [line] = sampleLines(ctx)
    const orderId = await createSentOrder(ctx)
    await setStock(ctx, line!.productId, line!.quantity - 1)
    const before = await moneyState(ctx, orderId)

    const res = await pay(ctx, orderId)

    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      field: 'lines.0.quantity',
    })
    expect(ctx.gateway.charges).toHaveLength(0)
    expect(await moneyState(ctx, orderId)).toEqual(before)
  })

  it('cannot pay a draft, and a provider cannot pay', async () => {
    const created = await ctx.request
      .post('/api/orders')
      .set(as(ctx.seed.providerUserId))
      .send({ patientId: ctx.seed.patientId })

    expect((await pay(ctx, created.body.id)).status).toBe(404)
    const asProvider = await ctx.request
      .post(`/api/orders/${created.body.id}/pay`)
      .set(as(ctx.seed.providerUserId))
    expect(asProvider.status).toBe(403)
  })
})
