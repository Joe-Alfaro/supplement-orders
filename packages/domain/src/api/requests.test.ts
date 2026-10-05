import { describe, expect, it } from 'vitest'
import {
  idParamSchema,
  payOrderRequestSchema,
  replaceOrderLinesRequestSchema,
  updateStockRequestSchema,
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

  it('rejects negative stock and zero quantity', () => {
    expect(
      updateStockRequestSchema.safeParse({ stockQuantity: -1 }).success,
    ).toBe(false)
    expect(
      replaceOrderLinesRequestSchema.safeParse({
        lines: [{ productId: 1, quantity: 0, unitPriceCents: 100 }],
      }).success,
    ).toBe(false)
  })

  it('accepts an empty pay body', () => {
    expect(payOrderRequestSchema.safeParse({}).success).toBe(true)
  })

  it('coerces numeric route params and rejects junk', () => {
    expect(idParamSchema.parse('42')).toBe(42)
    expect(idParamSchema.safeParse('abc').success).toBe(false)
    expect(idParamSchema.safeParse('1.5').success).toBe(false)
  })
})
