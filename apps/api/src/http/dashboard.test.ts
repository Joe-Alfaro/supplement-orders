import { computePlatformFee } from '@supplement-orders/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInternalTestContext,
  type InternalTestContext,
} from '../testing/harness'
import {
  as,
  createSentOrder,
  pay,
  withPaidOrdersUnfrozen,
} from '../testing/flows'

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

    expect(res.body).toMatchObject({
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
      'range',
    ])
    expect(other.body.gmvCents).toBe(0)
  })
})

describe('GET /api/dashboard range (revision 11a-v2)', () => {
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

  function setNow(iso: string) {
    if (!ctx.clock) throw new Error('harness has no clock')
    ctx.clock.now = new Date(iso)
  }

  async function paidOrderAt(paidAt: string) {
    const orderId = await createSentOrder(ctx)
    expect((await pay(ctx, orderId)).status).toBe(200)
    // A paid order is frozen (revision 15.5); pinning paid_at is a fixture.
    await withPaidOrdersUnfrozen(ctx.db, (tx) =>
      tx.execute(
        sql`update orders set paid_at = ${paidAt}::timestamptz where id = ${orderId}`,
      ),
    )
    return orderId
  }

  /** Every order from createSentOrder is identical, so GMV counts orders. */
  async function unitGmv() {
    await paidOrderAt('2000-01-01T00:00:00Z')
    return (await dashboard({ range: 'all' })).body.gmvCents as number
  }

  async function dashboard(
    query: Record<string, string>,
    userId = ctx.seed.providerUserId,
  ) {
    return ctx.request.get('/api/dashboard').query(query).set(as(userId))
  }

  async function countIn(query: Record<string, string>, unit: number) {
    const res = await dashboard(query)
    expect(res.status).toBe(200)
    return res.body.gmvCents / unit
  }

  const empty = { gmvCents: 0, providerMarginCents: 0, platformFeeCents: 0 }

  it('defaults to this month in UTC and echoes the resolved range', async () => {
    setNow('2026-10-15T12:00:00Z')
    const unit = await unitGmv()
    await paidOrderAt('2026-10-02T00:00:00Z')
    const res = await dashboard({})
    expect(res.body.range).toEqual({
      preset: 'month',
      from: '2026-10-01',
      to: '2026-10-15',
      timeZone: 'UTC',
    })
    expect(res.body.gmvCents).toBe(unit)
    expect(res.body).toEqual((await dashboard({ range: 'month' })).body)
  })

  it('month covers the 1st through today, inclusive of both edges', async () => {
    setNow('2026-10-15T12:00:00Z')
    const unit = await unitGmv()
    await Promise.all(
      [
        '2026-09-30T23:59:59Z',
        '2026-10-01T00:00:00Z',
        '2026-10-15T23:59:59Z',
        '2026-10-16T00:00:00Z',
      ].map(paidOrderAt),
    )
    expect(await countIn({ range: 'month' }, unit)).toBe(2)
  })

  it('month boundary follows the zone: Oct 31 evening in Chicago is still October', async () => {
    setNow('2026-11-01T03:00:00Z')
    const unit = await unitGmv()
    await Promise.all(
      [
        '2026-10-01T04:59:59Z',
        '2026-10-01T05:00:00Z',
        '2026-11-01T04:59:59Z',
        '2026-11-01T05:00:00Z',
      ].map(paidOrderAt),
    )
    const res = await dashboard({ range: 'month', tz: 'America/Chicago' })
    expect(res.body.range).toEqual({
      preset: 'month',
      from: '2026-10-01',
      to: '2026-10-31',
      timeZone: 'America/Chicago',
    })
    expect(res.body.gmvCents / unit).toBe(2)
    // The same instant is already November in UTC, so the window differs.
    expect((await dashboard({ range: 'month' })).body.range.from).toBe(
      '2026-11-01',
    )
  })

  it('last30 is today and the 29 days before, inclusive', async () => {
    setNow('2026-10-07T12:00:00Z')
    const unit = await unitGmv()
    await Promise.all(
      [
        '2026-09-07T23:59:59Z',
        '2026-09-08T00:00:00Z',
        '2026-10-07T23:59:59Z',
        '2026-10-08T00:00:00Z',
      ].map(paidOrderAt),
    )
    const res = await dashboard({ range: 'last30' })
    expect(res.body.range).toMatchObject({
      from: '2026-09-08',
      to: '2026-10-07',
    })
    expect(res.body.gmvCents / unit).toBe(2)
  })

  it('all has no bounds and null days, and ignores the clock', async () => {
    setNow('2026-10-07T12:00:00Z')
    const unit = await unitGmv()
    await paidOrderAt('2026-10-05T00:00:00Z')
    await paidOrderAt('2030-01-01T00:00:00Z')
    const res = await dashboard({ range: 'all', tz: 'Asia/Tokyo' })
    expect(res.body.range).toEqual({
      preset: 'all',
      from: null,
      to: null,
      timeZone: 'Asia/Tokyo',
    })
    expect(res.body.gmvCents / unit).toBe(3)
  })

  it('custom includes both days entirely', async () => {
    const unit = await unitGmv()
    await Promise.all(
      [
        '2026-09-30T23:59:59Z',
        '2026-10-01T00:00:00Z',
        '2026-10-03T23:59:59Z',
        '2026-10-04T00:00:00Z',
      ].map(paidOrderAt),
    )
    const res = await dashboard({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-03',
    })
    expect(res.body.range).toEqual({
      preset: 'custom',
      from: '2026-10-01',
      to: '2026-10-03',
      timeZone: 'UTC',
    })
    expect(res.body.gmvCents / unit).toBe(2)
  })

  it('custom single day and a 366-day span are accepted', async () => {
    const unit = await unitGmv()
    await paidOrderAt('2026-10-01T12:00:00Z')
    expect(
      await countIn(
        { range: 'custom', from: '2026-10-01', to: '2026-10-01' },
        unit,
      ),
    ).toBe(1)
    const long = await dashboard({
      range: 'custom',
      from: '2025-10-07',
      to: '2026-10-07',
    })
    expect(long.status).toBe(200)
  })

  it('a fall-back day in Chicago is 25 hours long', async () => {
    const unit = await unitGmv()
    await Promise.all(
      [
        '2026-11-01T04:59:59Z', // Oct 31 23:59:59 CDT
        '2026-11-01T05:00:00Z', // Nov 1 00:00 CDT
        '2026-11-02T05:59:59Z', // Nov 1 23:59:59 CST
        '2026-11-02T06:00:00Z', // Nov 2 00:00 CST
      ].map(paidOrderAt),
    )
    expect(
      await countIn(
        {
          range: 'custom',
          from: '2026-11-01',
          to: '2026-11-01',
          tz: 'America/Chicago',
        },
        unit,
      ),
    ).toBe(2)
  })

  it('a spring-forward day in New York is 23 hours long', async () => {
    const unit = await unitGmv()
    await Promise.all(
      [
        '2026-03-08T04:59:59Z', // Mar 7 23:59:59 EST
        '2026-03-08T05:00:00Z', // Mar 8 00:00 EST
        '2026-03-09T03:59:59Z', // Mar 8 23:59:59 EDT
        '2026-03-09T04:00:00Z', // Mar 9 00:00 EDT
      ].map(paidOrderAt),
    )
    expect(
      await countIn(
        {
          range: 'custom',
          from: '2026-03-08',
          to: '2026-03-08',
          tz: 'America/New_York',
        },
        unit,
      ),
    ).toBe(2)
  })

  it('filters margin and fees with the same window as GMV', async () => {
    setNow('2026-10-07T12:00:00Z')
    await paidOrderAt('2026-09-01T12:00:00Z')
    await paidOrderAt('2026-10-05T12:00:00Z')
    const all = (await dashboard({ range: 'all' })).body
    const month = (await dashboard({ range: 'month' })).body
    expect(month.gmvCents).toBe(all.gmvCents / 2)
    expect(month.providerMarginCents).toBe(all.providerMarginCents / 2)
    expect(month.platformFeeCents).toBe(all.platformFeeCents / 2)
  })

  it('is empty, not an error, when nothing was paid in range', async () => {
    setNow('2026-10-07T12:00:00Z')
    await paidOrderAt('2026-01-01T12:00:00Z')
    const res = await dashboard({ range: 'month' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject(empty)
  })

  it('never shows another provider’s orders in range', async () => {
    setNow('2026-10-07T12:00:00Z')
    await paidOrderAt('2026-10-05T12:00:00Z')
    const res = await dashboard(
      { range: 'month' },
      ctx.seed.otherProviderUserId,
    )
    expect(res.body).toMatchObject(empty)
  })

  it.each([
    ['an unknown time zone', { tz: 'Mars/Olympus' }, 'tz'],
    ['custom without days', { range: 'custom' }, 'from'],
    ['custom without to', { range: 'custom', from: '2026-10-01' }, 'to'],
    ['days with the default preset', { from: '2026-10-01' }, 'from'],
    ['days with last30', { range: 'last30', to: '2026-10-01' }, 'to'],
    ['days with all', { range: 'all', from: '2026-10-01' }, 'from'],
    ['an unknown preset', { range: 'week' }, 'range'],
    [
      'reversed days',
      { range: 'custom', from: '2026-10-02', to: '2026-10-01' },
      'to',
    ],
    [
      'more than 366 days',
      { range: 'custom', from: '2025-10-06', to: '2026-10-07' },
      'to',
    ],
    [
      'an instant instead of a day',
      { range: 'custom', from: '2026-10-01T00:00:00Z', to: '2026-10-02' },
      'from',
    ],
  ])('answers 400 VALIDATION_ERROR for %s', async (_label, query, field) => {
    const res = await dashboard(query)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.field).toBe(field)
  })
})
