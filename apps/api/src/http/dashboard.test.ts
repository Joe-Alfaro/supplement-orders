import { computePlatformFee } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
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

describe('GET /api/dashboard date range (revision 11a)', () => {
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

  async function paidOrderAt(paidAt: string, userId = ctx.seed.providerUserId) {
    const orderId = await createSentOrder(ctx)
    expect((await pay(ctx, orderId)).status).toBe(200)
    await ctx.db.execute(
      sql`update orders set paid_at = ${paidAt}::timestamptz where id = ${orderId}`,
    )
    return { orderId, userId }
  }

  async function dashboard(
    query: Record<string, string>,
    userId = ctx.seed.providerUserId,
  ) {
    return ctx.request.get('/api/dashboard').query(query).set(as(userId))
  }

  const lifetime = async () => (await dashboard({})).body

  it('includes from and excludes to', async () => {
    await paidOrderAt('2026-10-01T00:00:00Z')
    const all = await lifetime()
    expect(all.gmvCents).toBeGreaterThan(0)

    const atFrom = await dashboard({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
    })
    const atTo = await dashboard({
      from: '2026-09-30T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    })
    expect(atFrom.body).toEqual(all)
    expect(atTo.body).toEqual({
      gmvCents: 0,
      providerMarginCents: 0,
      platformFeeCents: 0,
    })
  })

  it('compares instants, not wall-clock text, across offsets', async () => {
    await paidOrderAt('2026-10-01T07:00:00Z')
    const all = await lifetime()
    const res = await dashboard({
      from: '2026-10-01T00:00:00-07:00',
      to: '2026-10-01T00:00:01-07:00',
    })
    expect(res.body).toEqual(all)
  })

  it('filters margin and fees with the same window as GMV', async () => {
    await paidOrderAt('2026-09-15T12:00:00Z')
    await paidOrderAt('2026-10-05T12:00:00Z')
    const all = await lifetime()

    const october = (
      await dashboard({
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
      })
    ).body
    expect(october.gmvCents).toBe(all.gmvCents / 2)
    expect(october.providerMarginCents).toBe(all.providerMarginCents / 2)
    expect(october.platformFeeCents).toBe(all.platformFeeCents / 2)
  })

  it('applies only from', async () => {
    await paidOrderAt('2026-09-15T12:00:00Z')
    await paidOrderAt('2026-10-05T12:00:00Z')
    const all = await lifetime()
    const res = await dashboard({ from: '2026-10-01T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(res.body.gmvCents).toBe(all.gmvCents / 2)
  })

  it('applies only to', async () => {
    await paidOrderAt('2026-09-15T12:00:00Z')
    await paidOrderAt('2026-10-05T12:00:00Z')
    const all = await lifetime()
    const res = await dashboard({ to: '2026-10-01T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(res.body.gmvCents).toBe(all.gmvCents / 2)
  })

  it('treats no params as lifetime totals', async () => {
    await paidOrderAt('2020-01-01T00:00:00Z')
    await paidOrderAt('2026-10-05T12:00:00Z')
    const res = await dashboard({})
    expect(res.body.gmvCents).toBeGreaterThan(0)
    expect(
      (
        await dashboard({
          from: '2000-01-01T00:00:00Z',
          to: '2100-01-01T00:00:00Z',
        })
      ).body,
    ).toEqual(res.body)
  })

  it('never shows another provider’s orders in range', async () => {
    await paidOrderAt('2026-10-05T12:00:00Z')
    const res = await dashboard(
      { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
      ctx.seed.otherProviderUserId,
    )
    expect(res.body).toEqual({
      gmvCents: 0,
      providerMarginCents: 0,
      platformFeeCents: 0,
    })
  })

  it.each([
    ['from without an offset', { from: '2026-10-01T00:00:00' }, 'from'],
    ['to as a date only', { to: '2026-10-01' }, 'to'],
    ['from that is not a date', { from: 'soon' }, 'from'],
    ['empty to', { to: '' }, 'to'],
    [
      'from equal to to',
      { from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      'to',
    ],
    [
      'from after to',
      { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      'to',
    ],
  ])('answers 400 VALIDATION_ERROR for %s', async (_label, query, field) => {
    const res = await dashboard(query)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.field).toBe(field)
  })
})
