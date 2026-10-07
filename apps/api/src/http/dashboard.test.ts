import { computePlatformFee } from '@supplement-orders/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import { as, createSentOrder, pay } from '../testing/flows'

describe('GET /api/dashboard', () => {
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

  it('is empty before anything is paid', async () => {
    await createSentOrder(ctx)

    const res = await ctx.request
      .get('/api/dashboard')
      .set(as(ctx.seed.providerUserId))

    expect(res.body).toEqual({
      gmvCents: 0,
      providerMarginCents: 0,
      platformFeeCents: 0,
    })
  })

  it('totals GMV from payments and margin/fees from the ledger', async () => {
    const [a, b] = ctx.seed.products
    const first = await createSentOrder(ctx, [
      { productId: a!.id, quantity: 1, unitPriceCents: 12000 },
    ])
    const second = await createSentOrder(ctx, [
      { productId: b!.id, quantity: 3, unitPriceCents: b!.cogsCents + 500 },
    ])
    const paid = await Promise.all([pay(ctx, first), pay(ctx, second)])

    const res = await ctx.request
      .get('/api/dashboard')
      .set(as(ctx.seed.providerUserId))
    const other = await ctx.request
      .get('/api/dashboard')
      .set(as(ctx.seed.otherProviderUserId))

    // Revision 2: patients pay the subtotal; the fee comes out of the margin.
    const subtotals = [12000, 3 * (b!.cogsCents + 500)]
    const fees = subtotals.map(computePlatformFee)
    expect(paid.map((r) => r.body.totalCents)).toEqual(subtotals)
    expect(res.body.gmvCents).toBe(subtotals[0]! + subtotals[1]!)
    expect(res.body.platformFeeCents).toBe(fees[0]! + fees[1]!)
    expect(res.body.providerMarginCents).toBe(
      12000 - a!.cogsCents - fees[0]! + (3 * 500 - fees[1]!),
    )
    // Revision 9 (M4): the paid-order list moved to GET /api/orders?status=paid.
    expect(Object.keys(res.body).sort()).toEqual([
      'gmvCents',
      'platformFeeCents',
      'providerMarginCents',
    ])
    expect(other.body.gmvCents).toBe(0)
  })
})
