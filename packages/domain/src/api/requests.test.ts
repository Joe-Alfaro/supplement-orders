import { describe, expect, it } from 'vitest'
import {
  idParamSchema,
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

  it('coerces numeric route params and rejects junk', () => {
    expect(idParamSchema.parse('42')).toBe(42)
    expect(idParamSchema.safeParse('abc').success).toBe(false)
    expect(idParamSchema.safeParse('1.5').success).toBe(false)
  })
})
