import { describe, expect, it } from 'vitest'
import {
  calendarDayInZone,
  dashboardQuerySchema,
  idParamSchema,
  POSTGRES_INTEGER_MAX,
  resolveDashboardRange,
  payOrderRequestSchema,
  replaceOrderLinesRequestSchema,
} from './requests'

describe('API request schemas', () => {
  it('accepts integer-cent order lines and an empty draft', () => {
    expect(
      replaceOrderLinesRequestSchema.safeParse({
        lines: [{ productId: 1, quantity: 2, unitPriceCents: 1500 }],
      }).success,
    ).toBe(true)
    expect(
      replaceOrderLinesRequestSchema.safeParse({ lines: [] }).success,
    ).toBe(true)
  })

  it('accepts incomplete draft lines and normalizes them', () => {
    const result = replaceOrderLinesRequestSchema.parse({
      lines: [{}, { productId: 3, unitPriceCents: null }, { productId: null }],
    })

    expect(result.lines).toEqual([
      { productId: null, quantity: 1, unitPriceCents: null },
      { productId: 3, quantity: 1, unitPriceCents: null },
      { productId: null, quantity: 1, unitPriceCents: null },
    ])
  })

  it('reports the offending line field as a path', () => {
    const result = replaceOrderLinesRequestSchema.safeParse({
      lines: [
        { productId: 1, quantity: 1, unitPriceCents: 100 },
        { productId: 2, quantity: 1, unitPriceCents: 10.5 },
      ],
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([
      'lines',
      1,
      'unitPriceCents',
    ])
  })

  it('rejects client-supplied COGS', () => {
    const result = replaceOrderLinesRequestSchema.safeParse({
      lines: [
        { productId: 1, quantity: 1, unitPriceCents: 100, unitCogsCents: 1 },
      ],
    })

    expect(result.success).toBe(false)
  })

  it('rejects negative prices and zero quantity', () => {
    expect(
      replaceOrderLinesRequestSchema.safeParse({
        lines: [{ productId: 1, unitPriceCents: -1 }],
      }).success,
    ).toBe(false)
    expect(
      replaceOrderLinesRequestSchema.safeParse({
        lines: [{ productId: 1, quantity: 0, unitPriceCents: 100 }],
      }).success,
    ).toBe(false)
  })

  it('requires the quote the patient saw on pay (revision 9)', () => {
    expect(
      payOrderRequestSchema.safeParse({
        expectedRevision: 1,
        expectedTotalCents: 2000,
      }).success,
    ).toBe(true)
    expect(payOrderRequestSchema.safeParse({}).success).toBe(false)
  })

  it.each([
    [{ expectedTotalCents: 2000 }, 'expectedRevision'],
    [{ expectedRevision: 0, expectedTotalCents: 2000 }, 'expectedRevision'],
    [{ expectedRevision: '1', expectedTotalCents: 2000 }, 'expectedRevision'],
    [{ expectedRevision: 1 }, 'expectedTotalCents'],
    [{ expectedRevision: 1, expectedTotalCents: -1 }, 'expectedTotalCents'],
    [{ expectedRevision: 1, expectedTotalCents: 10.5 }, 'expectedTotalCents'],
    [
      { expectedRevision: 1, expectedTotalCents: 0, simulateFailure: 'yes' },
      'simulateFailure',
    ],
  ])('rejects pay body %j on %s', (body, field) => {
    const result = payOrderRequestSchema.safeParse(body)
    expect(result.error?.issues[0]?.path).toEqual([field])
  })

  it('bounds draft lines: quantity 1..1000, price null or 0..1_000_000 (revision 9)', () => {
    const line = (l: object) =>
      replaceOrderLinesRequestSchema.safeParse({
        lines: [{ productId: 1, ...l }],
      })

    expect(line({ quantity: 1000, unitPriceCents: 1_000_000 }).success).toBe(
      true,
    )
    expect(line({ unitPriceCents: 0 }).success).toBe(true)
    expect(line({ quantity: 1001 }).error?.issues[0]?.path).toEqual([
      'lines',
      0,
      'quantity',
    ])
    expect(line({ quantity: 2_147_483_648 }).success).toBe(false)
    expect(line({ unitPriceCents: 1_000_001 }).error?.issues[0]?.path).toEqual([
      'lines',
      0,
      'unitPriceCents',
    ])
    expect(line({ unitPriceCents: Number.MAX_SAFE_INTEGER }).success).toBe(
      false,
    )
  })

  it('bounds ids to the Postgres integer range (revision 11)', () => {
    expect(idParamSchema.parse(String(POSTGRES_INTEGER_MAX))).toBe(
      POSTGRES_INTEGER_MAX,
    )
    expect(
      idParamSchema.safeParse(String(POSTGRES_INTEGER_MAX + 1)).success,
    ).toBe(false)
    expect(
      replaceOrderLinesRequestSchema.safeParse({
        lines: [{ productId: POSTGRES_INTEGER_MAX + 1 }],
      }).error?.issues[0]?.path,
    ).toEqual(['lines', 0, 'productId'])
  })

  it('coerces numeric route params and rejects junk', () => {
    expect(idParamSchema.parse('42')).toBe(42)
    expect(idParamSchema.safeParse('abc').success).toBe(false)
    expect(idParamSchema.safeParse('1.5').success).toBe(false)
  })
})

describe('dashboardQuerySchema', () => {
  it('defaults to month in UTC with no days', () => {
    expect(dashboardQuerySchema.parse({})).toEqual({
      preset: 'month',
      from: null,
      to: null,
      timeZone: 'UTC',
    })
  })

  it.each(['month', 'last30', 'all'] as const)('accepts preset %s', (range) => {
    expect(
      dashboardQuerySchema.parse({ range, tz: 'America/Chicago' }),
    ).toEqual({
      preset: range,
      from: null,
      to: null,
      timeZone: 'America/Chicago',
    })
  })

  it('accepts custom with inclusive days, including a single day', () => {
    expect(
      dashboardQuerySchema.parse({
        range: 'custom',
        from: '2026-10-01',
        to: '2026-10-01',
      }),
    ).toMatchObject({ preset: 'custom', from: '2026-10-01', to: '2026-10-01' })
  })

  it('accepts exactly 366 days and rejects 367', () => {
    const ok = dashboardQuerySchema.safeParse({
      range: 'custom',
      from: '2025-10-07',
      to: '2026-10-07',
    })
    const tooLong = dashboardQuerySchema.safeParse({
      range: 'custom',
      from: '2025-10-06',
      to: '2026-10-07',
    })
    expect(ok.success).toBe(true)
    expect(tooLong.success).toBe(false)
    expect(tooLong.error?.issues[0]?.path).toEqual(['to'])
  })

  it.each([
    ['unknown preset', { range: 'week' }, 'range'],
    ['unknown time zone', { tz: 'Mars/Olympus' }, 'tz'],
    ['empty time zone', { tz: '' }, 'tz'],
    ['custom without days', { range: 'custom' }, 'from'],
    ['custom without to', { range: 'custom', from: '2026-10-01' }, 'to'],
    ['custom without from', { range: 'custom', to: '2026-10-01' }, 'from'],
    ['days on the default preset', { from: '2026-10-01' }, 'from'],
    ['to on month', { range: 'month', to: '2026-10-01' }, 'to'],
    ['days on last30', { range: 'last30', from: '2026-10-01' }, 'from'],
    ['days on all', { range: 'all', to: '2026-10-01' }, 'to'],
    [
      'reversed days',
      { range: 'custom', from: '2026-10-02', to: '2026-10-01' },
      'to',
    ],
    [
      'an instant instead of a day',
      { range: 'custom', from: '2026-10-01T00:00:00Z', to: '2026-10-02' },
      'from',
    ],
    [
      'an impossible day',
      { range: 'custom', from: '2026-02-30', to: '2026-03-01' },
      'from',
    ],
    [
      'an unpadded day',
      { range: 'custom', from: '2026-1-1', to: '2026-10-01' },
      'from',
    ],
  ])('rejects %s', (_label, query, field) => {
    const result = dashboardQuerySchema.safeParse(query)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([field])
  })

  it('rejects repeated params', () => {
    expect(
      dashboardQuerySchema.safeParse({ range: ['month', 'all'] }).success,
    ).toBe(false)
  })
})

describe('calendarDayInZone', () => {
  it('reads the local day, which can differ from the UTC day', () => {
    const instant = new Date('2026-10-01T03:30:00Z')
    expect(calendarDayInZone(instant, 'UTC')).toBe('2026-10-01')
    expect(calendarDayInZone(instant, 'America/Chicago')).toBe('2026-09-30')
    expect(calendarDayInZone(instant, 'Pacific/Auckland')).toBe('2026-10-01')
  })
})

describe('resolveDashboardRange', () => {
  const base = { timeZone: 'America/Chicago' }

  it('month runs from the 1st through today', () => {
    expect(
      resolveDashboardRange(
        { preset: 'month', from: null, to: null, ...base },
        '2026-10-07',
      ),
    ).toEqual({
      preset: 'month',
      from: '2026-10-01',
      to: '2026-10-07',
      ...base,
    })
    expect(
      resolveDashboardRange(
        { preset: 'month', from: null, to: null, ...base },
        '2026-10-01',
      ),
    ).toMatchObject({ from: '2026-10-01', to: '2026-10-01' })
  })

  it('last30 is today and the 29 days before it, across month and year ends', () => {
    const resolve = (today: string) =>
      resolveDashboardRange(
        { preset: 'last30', from: null, to: null, ...base },
        today,
      )
    expect(resolve('2026-10-07')).toMatchObject({
      from: '2026-09-08',
      to: '2026-10-07',
    })
    expect(resolve('2026-01-15')).toMatchObject({
      from: '2025-12-17',
      to: '2026-01-15',
    })
    expect(resolve('2028-03-01')).toMatchObject({
      from: '2028-02-01',
      to: '2028-03-01',
    })
  })

  it('all has no days', () => {
    expect(
      resolveDashboardRange(
        { preset: 'all', from: null, to: null, ...base },
        '2026-10-07',
      ),
    ).toEqual({ preset: 'all', from: null, to: null, ...base })
  })

  it('custom echoes the given days', () => {
    expect(
      resolveDashboardRange(
        { preset: 'custom', from: '2026-01-01', to: '2026-01-31', ...base },
        '2026-10-07',
      ),
    ).toEqual({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      ...base,
    })
  })
})
