import { describe, expect, it } from 'vitest'
import {
  dashboardQuerySchema,
  idParamSchema,
  POSTGRES_INTEGER_MAX,
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
  it('parses no params as lifetime (both bounds null)', () => {
    expect(dashboardQuerySchema.parse({})).toEqual({ from: null, to: null })
  })

  it('parses instants with Z or an explicit offset', () => {
    const parsed = dashboardQuerySchema.parse({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-08T00:00:00-07:00',
    })
    expect(parsed.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(parsed.to?.toISOString()).toBe('2026-10-08T07:00:00.000Z')
  })

  it('accepts only one bound', () => {
    expect(
      dashboardQuerySchema.parse({ from: '2026-10-01T00:00:00Z' }).to,
    ).toBeNull()
    expect(
      dashboardQuerySchema.parse({ to: '2026-10-01T00:00:00Z' }).from,
    ).toBeNull()
  })

  it.each([
    ['no offset', '2026-10-01T00:00:00'],
    ['date only', '2026-10-01'],
    ['garbage', 'yesterday'],
    ['empty', ''],
    ['impossible date', '2026-02-30T00:00:00Z'],
  ])('rejects %s on from and to', (_label, value) => {
    const from = dashboardQuerySchema.safeParse({ from: value })
    const to = dashboardQuerySchema.safeParse({ to: value })
    expect(from.success).toBe(false)
    expect(to.success).toBe(false)
    expect(from.error?.issues[0]?.path).toEqual(['from'])
    expect(to.error?.issues[0]?.path).toEqual(['to'])
  })

  it('rejects repeated params', () => {
    expect(
      dashboardQuerySchema.safeParse({
        from: ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'],
      }).success,
    ).toBe(false)
  })

  it('requires from strictly before to, reporting the error on to', () => {
    const same = dashboardQuerySchema.safeParse({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    })
    const reversed = dashboardQuerySchema.safeParse({
      from: '2026-10-02T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    })
    expect(same.success).toBe(false)
    expect(reversed.success).toBe(false)
    expect(reversed.error?.issues[0]?.path).toEqual(['to'])
  })
})
