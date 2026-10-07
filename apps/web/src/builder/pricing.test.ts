import { describe, expect, it } from 'vitest'
import { evaluatePricing, type PricingInputs } from './pricing'

const product = {
  id: 1,
  name: 'Vitamin D3',
  sku: 'VITD',
  cogsCents: 1200,
  stockQuantity: 10,
}

function inputs(overrides: Partial<PricingInputs>): PricingInputs {
  return {
    product,
    quantityInput: '1',
    priceInput: '',
    markupInput: '',
    source: 'price',
    ...overrides,
  }
}

describe('evaluatePricing lineMarginCents', () => {
  it('is line total minus qty x cost minus the line fee', () => {
    // 3 x $20.00 = 6000; cost 3 x 1200 = 3600; fee 75 bps of 6000 = 45.
    const result = evaluatePricing(
      inputs({ quantityInput: '3', priceInput: '20' }),
    )
    expect(result.lineMarginCents).toBe(6000 - 3600 - 45)
  })

  it('equals price - cost - fee for quantity 1', () => {
    // $12.10 less $12.00 cost less a 10 cent fee (ceil of 75 bps of 1210).
    const result = evaluatePricing(inputs({ priceInput: '12.10' }))
    expect(result.lineMarginCents).toBe(
      1210 - 1200 - (result.lineFeeCents ?? 0),
    )
    expect(result.lineMarginCents).toBeGreaterThanOrEqual(0)
  })

  it('goes negative below the minimum price', () => {
    const result = evaluatePricing(inputs({ priceInput: '12.00' }))
    expect(result.belowMinimum).toBe(true)
    expect(result.lineMarginCents).toBeLessThan(0)
  })

  it('is null when the line cannot be priced', () => {
    expect(evaluatePricing(inputs({})).lineMarginCents).toBeNull()
    expect(
      evaluatePricing(inputs({ priceInput: '20', quantityInput: '0' }))
        .lineMarginCents,
    ).toBeNull()
    expect(
      evaluatePricing(inputs({ product: null, priceInput: '20' }))
        .lineMarginCents,
    ).toBeNull()
  })
})
