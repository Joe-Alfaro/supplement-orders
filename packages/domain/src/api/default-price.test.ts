import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRICE_MAX_CENTS,
  minDefaultPriceCents,
  productDtoSchema,
  setDefaultPriceRequestSchema,
} from './index'
import { minUnitPriceCents } from '../money'

// Revision 20.2: a provider's default patient price for a product.

describe('default price request', () => {
  it('accepts an integer from 1 to 1,000,000', () => {
    expect(DEFAULT_PRICE_MAX_CENTS).toBe(1_000_000)
    expect(
      setDefaultPriceRequestSchema.parse({ unitPriceCents: 2000 }),
    ).toEqual({ unitPriceCents: 2000 })
    expect(
      setDefaultPriceRequestSchema.safeParse({ unitPriceCents: 1_000_000 })
        .success,
    ).toBe(true)
  })

  it.each([
    { unitPriceCents: 0 },
    { unitPriceCents: -5 },
    { unitPriceCents: 10.5 },
    { unitPriceCents: 1_000_001 },
    { unitPriceCents: '2000' },
    { unitPriceCents: null },
    {},
    { unitPriceCents: 2000, extra: true },
  ])('rejects %j', (body) => {
    const result = setDefaultPriceRequestSchema.safeParse(body)
    expect(result.success).toBe(false)
  })
})

describe('minDefaultPriceCents', () => {
  it('is the minimum unit price, but never below one cent', () => {
    expect(minDefaultPriceCents(850)).toBe(minUnitPriceCents(850))
    expect(minDefaultPriceCents(850)).toBe(857)
    expect(minDefaultPriceCents(0)).toBe(1)
  })
})

describe('provider product DTO', () => {
  it('requires a non-null defaultUnitPriceCents', () => {
    const row = {
      id: 1,
      sku: 'A',
      name: 'A',
      cogsCents: 850,
      stockQuantity: 3,
      defaultUnitPriceCents: 857,
    }
    expect(productDtoSchema.parse(row)).toEqual(row)
    expect(
      productDtoSchema.safeParse({ ...row, defaultUnitPriceCents: null })
        .success,
    ).toBe(false)
    expect(
      productDtoSchema.safeParse({ ...row, defaultUnitPriceCents: undefined })
        .success,
    ).toBe(false)
  })
})
