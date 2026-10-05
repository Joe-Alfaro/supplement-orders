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
      paidOrders: [],
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

    const totals = paid.map((r) => r.body.totals)
    const gmv = totals.reduce((s, t) => s + t.totalCents, 0)
    expect(res.body.gmvCents).toBe(gmv)
    expect(res.body.platformFeeCents).toBe(
      totals.reduce((s, t) => s + t.platformFeeCents, 0),
    )
    expect(res.body.providerMarginCents).toBe(12000 - a!.cogsCents + 3 * 500)
    expect(res.body.paidOrders).toHaveLength(2)
    res.body.paidOrders.forEach(
      (o: {
        totalCents: number
        cogsCents: number
        providerMarginCents: number
        platformFeeCents: number
      }) => {
        expect(o.cogsCents + o.providerMarginCents + o.platformFeeCents).toBe(
          o.totalCents,
        )
      },
    )
    expect(other.body.gmvCents).toBe(0)
  })
})
